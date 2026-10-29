import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { LegacyPlan, Plan, Status, Task } from '../types'

// Change the shape when Task's fields change: it declines what an earlier version stored
const plan = atom({ plugin: 'eta', key: 'plan' } as const, null, { shape: 'plan-1' })
// The plan as the Portuguese versions stored it: read once at start and migrated into `plan`
const legacyPlan = atom({ plugin: 'eta', key: 'plano' } as const, null, { shape: 'plano-2' })
const now = atom({ plugin: 'eta', key: 'now' } as const, 0)
// The band shows or hides, toggled by /eta
const open = atom({ plugin: 'eta', key: 'open' } as const, true)

const TOOL_PLAN = 'mcp__eta__plan'
const TOOL_TASK = 'mcp__eta__task'
const DEFAULT_GOAL = 'Session tasks'
const TICK_MS = 60_000
const HISTORY_MAX = 200
const MIN_SAMPLES = 5
const BAR = 8
// Overrun past which a task was most likely just never closed
const STALLED_MIN = 30
// A finished subagent or process stays in the tree this long, then leaves
const CLEANUP_MS = 5 * 60_000

// One-column symbols, so titles line up; color tells the statuses apart
const ICON: Record<Status, string> = {
  done: '✓', running: '▶', next: '○', waiting: '◷', blocked: '✕', question: '?',
}

type Sample = { estimated: number; actual: number }
type Part = { text: string; color?: Color; dim?: boolean; bold?: boolean }
type Row = { prefix: string; icon: Part; title: string; status: Part[]; dim: boolean }

// ── time ─────────────────────────────────────────────────────────────────

// h:mm, without the :00 of whole hours
const hm = (min: number) => {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return m === 0 ? `${h}` : `${h}:${String(m).padStart(2, '0')}`
}
// One short duration: 12 min, 1:20 h, 20 h
// From 10 h up the minutes are noise: round to the hour
const dur = (min: number) => {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m} min`
  return m >= 600 ? `${Math.round(m / 60)} h` : `${hm(m)} h`
}

function range(a: number, b: number): string {
  const lo = Math.max(0, Math.round(a))
  const hi = Math.max(lo, Math.round(b))
  if (hi < 60) return lo === hi ? `${hi} min` : `${lo}–${hi} min`
  if (hi >= 600) {
    const [a, b] = [Math.round(lo / 60), Math.round(hi / 60)]
    return a === b ? `${b} h` : `${a}–${b} h`
  }
  return lo === hi ? `${hm(hi)} h` : `${hm(lo)}–${hm(hi)} h`
}

// A range too wide says little: the midpoint first and the range in parentheses, ~14 h (4–24)
function likely(lo: number, hi: number): string {
  if (hi < 60 || hi <= lo * 1.5) return range(lo, hi)
  return `~${dur((lo + hi) / 2)} (${range(lo, hi).replace(/ (min|h)$/, '')})`
}

// Subagents and background processes: real parallel work, with an icon of their own while they run
const PARALLEL: Record<NonNullable<Task['kind']>, { text: string; color: Color }> = {
  agent: { text: '◆', color: 'claude' },
  process: { text: '◐', color: 'planMode' },
}
const expired = (t: Task, ms: number) => t.kind != null && t.status !== 'running' && t.end != null && ms - t.end > CLEANUP_MS

const elapsed = (t: Task, ms: number) => (t.start == null ? 0 : Math.max(0, ((t.end ?? ms) - t.start) / 60_000))
const overdue = (t: Task, ms: number) => t.estimated && t.status === 'running' && elapsed(t, ms) > t.max
const stalled = (t: Task, ms: number) => overdue(t, ms) && elapsed(t, ms) - t.max >= Math.max(STALLED_MIN, t.max)
const rangeOf = (t: Task) => (t.estimated ? range(t.min, t.max) : '?')
const took = (t: Task, ms: number) => dur(elapsed(t, ms))

// Running task: bar and % over the range's midpoint (up to 99%), and what is left; past the ceiling, only the overrun
function progress(t: Task, ms: number): Part[] {
  const d = elapsed(t, ms)
  if (!t.estimated) return [{ text: dur(d), color: 'suggestion' }]
  if (d > t.max) return [{ text: `${stalled(t, ms) ? 'stalled? ' : ''}+${dur(d - t.max)} over`, color: 'warning' }]
  const mid = (t.min + t.max) / 2 || t.max || 1
  const pct = Math.min(99, Math.floor((d / mid) * 100))
  const full = Math.max(0, Math.min(BAR, Math.floor((pct / 100) * BAR) || 0))
  const left = d >= t.min ? `up to ${dur(t.max - d)} left` : `${likely(t.min - d, t.max - d)} left`
  return [
    { text: '━'.repeat(full), color: 'suggestion' },
    { text: '─'.repeat(BAR - full), dim: true },
    { text: `  ${pct}% · ${left}`, color: 'suggestion' },
  ]
}

// ── calibration ──────────────────────────────────────────────────────────

async function factor($: { store: { get: (k: string) => Promise<unknown> } }) {
  const hist = ((await $.store.get('history')) ?? []) as Sample[]
  if (hist.length < MIN_SAMPLES) return { factor: null, n: hist.length }
  const r = hist.map(a => a.actual / a.estimated).sort((x, y) => x - y)
  return { factor: r[Math.floor(r.length / 2)] ?? null, n: hist.length }
}

// ── plan ─────────────────────────────────────────────────────────────────

// An agent does one thing at a time: what is queued adds up in series. Only running tasks run
// together, so of those the longest counts
function remaining(p: Plan, ms: number): [number, number] {
  let lo = 0
  let hi = 0
  let runLo = 0
  let runHi = 0
  for (const t of p.tasks) {
    // A question does not count until it is answered: it shows as "need you"
    if (t.status === 'done' || t.status === 'question' || !t.estimated) continue
    if (t.status === 'running') {
      const spent = elapsed(t, ms)
      runLo = Math.max(runLo, t.min - spent)
      runHi = Math.max(runHi, t.max - spent)
    } else {
      lo += t.min
      hi += t.max
    }
  }
  return [lo + Math.max(0, runLo), hi + Math.max(0, runHi)]
}

function iconOf(t: Task, ms: number): Part {
  if (overdue(t, ms)) return { text: '!', color: 'warning' }
  if (t.kind && t.status === 'running') return PARALLEL[t.kind]
  const text = ICON[t.status]
  if (t.status === 'running' || t.status === 'done') return { text, color: 'success' }
  if (t.status === 'waiting') return { text, color: 'permission' }
  if (t.status === 'blocked') return { text, color: 'error' }
  if (t.status === 'question') return { text, color: 'suggestion', bold: true }
  return { text, color: 'warning' }
}

function statusOf(t: Task, ms: number): Part[] {
  // A task born done has no real duration to show
  if (t.status === 'done') return elapsed(t, ms) >= 1 ? [{ text: `took ${took(t, ms)}` }] : []
  if (t.status === 'running') return progress(t, ms)
  if (t.kind && t.status === 'blocked') return [{ text: `${t.waitingOn ?? 'failed'} · took ${took(t, ms)}`, color: 'error' }]
  const then = t.estimated && t.max > 0 ? ` · then ${rangeOf(t)}` : ''
  if (t.status === 'waiting') return [{ text: `? ${t.waitingOn ?? ''}`.trim() + then, color: 'permission' }]
  if (t.status === 'question') {
    return [{ text: t.waitingOn ?? 'awaiting your answer', color: 'suggestion' }, { text: then, dim: true }]
  }
  return [{ text: rangeOf(t), dim: true }]
}

// Questions stay out of the tree, in a section below it; what depends on a question waits for the answer and
// leaves with it. Once answered (any other status), the task returns to its place in the tree
function questions(p: Plan): { question: Task; held: Set<string> }[] {
  const children = new Map<string, Task[]>()
  for (const t of p.tasks) if (t.parent != null) children.set(t.parent, [...(children.get(t.parent) ?? []), t])
  return p.tasks
    .filter(t => t.status === 'question')
    .map(q => {
      const held = new Set<string>()
      const stack = [q.id]
      while (stack.length > 0) {
        for (const c of children.get(stack.pop()!) ?? []) {
          if (c.id === q.id || held.has(c.id)) continue
          held.add(c.id)
          stack.push(c.id)
        }
      }
      return { question: q, held }
    })
}

function questionRows(p: Plan, ms: number): Row[] {
  return questions(p).map(({ question: t, held }) => {
    const n = p.tasks.filter(x => held.has(x.id) && x.status !== 'done').length
    const status = statusOf(t, ms)
    if (n > 0) status.push({ text: ` · +${n} after`, dim: true })
    return { prefix: '', icon: iconOf(t, ms), title: t.title, status, dim: false }
  })
}

// └ indented = depends on the parent task; tasks at the same indent are independent of each other
function tree(p: Plan, ms: number): Row[] {
  const out = new Set([...questions(p).flatMap(q => [q.question.id, ...q.held]), ...p.tasks.filter(t => expired(t, ms)).map(t => t.id)])
  const tasks = p.tasks.filter(t => !out.has(t.id))
  const ids = new Set(tasks.map(t => t.id))
  const children = new Map<string | null, Task[]>()
  for (const t of tasks) {
    const parent = t.parent != null && ids.has(t.parent) ? t.parent : null
    children.set(parent, [...(children.get(parent) ?? []), t])
  }
  const row = (t: Task, prefix: string): Row => (
    { prefix, icon: iconOf(t, ms), title: t.title, status: statusOf(t, ms), dim: t.status === 'done' }
  )

  const rows: Row[] = []
  // └ sits under the parent's icon: each level 2 columns further
  const indent = (n: number) => (n === 0 ? '' : `${' '.repeat(2 * (n - 1))}└ `)
  // A parent that points at a descendant would close a cycle: each task comes out once
  const seen = new Set<string>()
  const walk = (list: Task[], level: number) => {
    for (const t of list) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      rows.push(row(t, indent(level)))
      walk(children.get(t.id) ?? [], level + 1)
    }
  }
  walk(children.get(null) ?? [], 0)
  return rows
}

const statusText = (r: Row) => r.status.map(s => s.text).join('')
const rowText = (r: Row) => `${r.prefix}${r.icon.text} ${r.title}${r.status.length ? ` — ${statusText(r)}` : ''}`

// Cut to n columns with …, counting by character
function cut(s: string, n: number): string {
  const cs = Array.from(s)
  if (cs.length <= n) return s
  return n <= 1 ? '…' : `${cs.slice(0, n - 1).join('').trimEnd()}…`
}

// Local end time: the mod's runtime has no time zone, so the offset comes from the machine's `date +%z`
let offsetMin = 0
const local = (ms: number) => new Date(ms + offsetMin * 60_000)
const clockTime = (ms: number) => {
  const d = local(ms)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// 15:22 (today), tomorrow 04:46 or Oct 31 09:00
function when(target: number, ms: number): string {
  const day = (x: number) => Math.floor(local(x).getTime() / 86_400_000)
  const dd = day(target) - day(ms)
  if (dd <= 0) return clockTime(target)
  if (dd === 1) return `tomorrow ${clockTime(target)}`
  const d = local(target)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${clockTime(target)}`
}
function ending(p: Plan, ms: number): string {
  const [lo, hi] = remaining(p, ms)
  return hi <= 0 ? '' : `ends ~${when(ms + ((lo + hi) / 2) * 60_000, ms)}`
}

const unestimated = (p: Plan) =>
  p.tasks.filter(t => !t.estimated && !t.kind && t.status !== 'done' && t.status !== 'question').length
const left = (p: Plan, ms: number) => {
  const [lo, hi] = remaining(p, ms)
  const n = unestimated(p)
  const q = p.tasks.filter(t => t.status === 'question').length
  return `${likely(lo, hi)} left${n > 0 ? ` + ${n} unestimated` : ''}${q > 0 ? ` + ${q} need you` : ''}`
}

// The band's first line: done/total · ◷ ~13 h left · +2 pending · ✓ ends ~23:02
function headline(p: Plan, ms: number): string {
  const [lo, hi] = remaining(p, ms)
  const done = p.tasks.filter(t => t.status === 'done').length
  const n = unestimated(p)
  const q = p.tasks.filter(t => t.status === 'question').length
  const end = ending(p, ms)
  return [
    `✓ ${done}/${p.tasks.length}`,
    ...(hi > 0 ? [`◷ ~${dur((lo + hi) / 2)} left`] : []),
    ...(q > 0 ? [`+${q} pending`] : []),
    ...(n > 0 ? [`+${n} unestimated`] : []),
    ...(end ? [`✓ ${end}`] : []),
  ].join(' · ')
}

function planText(p: Plan, ms: number, cal: { factor: number | null; n: number }): string {
  const [lo, hi] = remaining(p, ms)
  const end = ending(p, ms)
  const qs = questionRows(p, ms).map(rowText)
  const lines = [
    `🎯 ${p.goal} — ⏱ ${left(p, ms)}${end ? ` · ${end}` : ''}`,
    ...tree(p, ms).map(rowText),
    ...(qs.length > 0 ? ['Questions for the user (out of the tree until answered):', ...qs] : []),
  ]
  if (cal.factor != null) {
    lines.push(
      `Calibration: your tasks take ${cal.factor.toFixed(1)}× the midpoint estimate (n=${cal.n}); ` +
        `corrected, ${range(lo * cal.factor, hi * cal.factor)} left. Scale your next ranges by this factor.`,
    )
  } else {
    lines.push(`Calibration: ${cal.n}/${MIN_SAMPLES} tasks measured, no factor yet.`)
  }
  const stalledTasks = p.tasks.filter(t => stalled(t, ms))
  if (stalledTasks.length > 0) {
    lines.push(`Stalled far past their ceiling: ${stalledTasks.map(t => t.title).join(' · ')}. Mark them done or re-estimate with ${TOOL_TASK}.`)
  }
  return lines.join('\n')
}

// ── tool input ───────────────────────────────────────────────────────────

const STATUSES = Object.keys(ICON) as Status[]
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const status = (v: unknown): Status | null => (STATUSES.includes(v as Status) ? (v as Status) : null)

// ── migration ────────────────────────────────────────────────────────────

const LEGACY_STATUS: Record<string, Status> = {
  proxima: 'next', andamento: 'running', feita: 'done', esperando: 'waiting', bloqueada: 'blocked', pergunta: 'question',
}
const LEGACY_KIND: Record<string, Task['kind']> = { agente: 'agent', processo: 'process' }
const legacyId = (id: string) => id.replace(/^agente:/, 'agent:').replace(/^processo:/, 'process:')

function fromLegacy(old: LegacyPlan): Plan {
  return {
    goal: old.objetivo,
    tasks: old.tarefas.map(t => {
      const kind = t.tipo ? LEGACY_KIND[t.tipo] : undefined
      return {
        id: legacyId(t.id), title: t.titulo, parent: t.pai == null ? null : legacyId(t.pai), min: t.min, max: t.max,
        status: LEGACY_STATUS[t.estado] ?? 'next', waitingOn: t.esperando, estimated: t.estimada, ref: t.ref,
        start: t.inicio, end: t.fim, ...(kind ? { kind } : {}),
      }
    }),
  }
}

// A session that ran the Portuguese version keeps its plan and its calibration history
async function migrate($: EngineInterface) {
  const old = await read($, legacyPlan)
  if (old && !(await read($, plan))) await update($, plan, () => fromLegacy(old))
  if (old) await update($, legacyPlan, () => null)
  if ((await $.store.get('history')) == null) {
    const hist = (await $.store.get('historico')) as { estimado: number; real: number }[] | undefined
    if (Array.isArray(hist)) await $.store.set('history', hist.map(a => ({ estimated: a.estimado, actual: a.real })))
  }
}

// ── transitions ──────────────────────────────────────────────────────────

// Applies the new status keeping the real times: starts on entering running, ends on turning done
function transition(t: Task, st: Status, ms: number): Task {
  return {
    ...t,
    status: st,
    start: t.start ?? (st === 'running' || st === 'done' ? ms : null),
    end: st === 'done' ? (t.end ?? ms) : null,
  }
}

// Reads the plan, applies the change and writes it; a calibration sample for each estimated task that just finished
async function apply($: EngineInterface, change: (p: Plan, ms: number) => Plan): Promise<{ before: Plan | null; after: Plan; ms: number }> {
  const ms = await $.clock.now()
  const before = await read($, plan)
  const after = change(before ?? { goal: DEFAULT_GOAL, tasks: [] }, ms)
  const wasDone = new Set((before?.tasks ?? []).filter(t => t.status === 'done').map(t => t.id))
  const samples: Sample[] = after.tasks
    .filter(t => t.status === 'done' && !wasDone.has(t.id) && t.estimated && t.start != null && t.end != null)
    .map(t => ({ estimated: (t.min + t.max) / 2, actual: (t.end! - t.start!) / 60_000 }))
    .filter(a => a.estimated > 0 && a.actual > 0.5)
  if (samples.length > 0) {
    const hist = ((await $.store.get('history')) ?? []) as Sample[]
    await $.store.set('history', [...hist, ...samples].slice(-HISTORY_MAX))
  }
  await update($, plan, () => after)
  await update($, now, () => ms)
  return { before, after, ms }
}

const FROM_TODO: Record<string, Status> = { pending: 'next', in_progress: 'running', completed: 'done' }
const mirrored = (t: Task) => t.id.startsWith('todo:') || t.id.startsWith('task:') || t.kind != null
const blank = (id: string, title: string, ref: string | null = null): Task => ({
  id, title, parent: null, min: 0, max: 0, status: 'next', waitingOn: null, estimated: false, ref, start: null, end: null,
})

// Joins as a child of the plan's only running task (it is work for it); with none or several, at the root
function addParallel(p: Plan, x: Pick<Task, 'id' | 'title' | 'kind' | 'ref' | 'start' | 'end'>): Plan {
  if (p.tasks.some(t => t.id === x.id)) return p
  const running = p.tasks.filter(t => t.status === 'running' && !t.kind)
  const t: Task = {
    ...blank(x.id, x.title, x.ref), ...x, parent: running.length === 1 ? running[0]!.id : null,
    status: x.end != null ? 'done' : 'running',
  }
  return { ...p, tasks: [...p.tasks, t] }
}

// Closes a subagent or process: done, or blocked with the reason when it failed or was killed
async function close($: EngineInterface, match: (t: Task) => boolean, result: string | undefined, durationMs?: number) {
  const p = await read($, plan)
  if (!p?.tasks.some(t => t.kind && t.status === 'running' && match(t))) return
  const failed = result === 'failed' ? 'failed' : result === 'killed' ? 'killed' : null
  await apply($, (cur, ms) => ({
    ...cur,
    tasks: cur.tasks.map(t => {
      if (!t.kind || t.status !== 'running' || !match(t)) return t
      const end = durationMs != null && t.start != null ? Math.max(t.start, Math.min(ms, t.start + durationMs)) : ms
      return { ...t, status: failed ? 'blocked' : 'done', waitingOn: failed, end }
    }),
  }))
}

// On load (a new session or a reload of the mod), subagents already running join the tree; their real start
// is unknown, so it counts from here. Background shells have no list: only those started later show
async function seedAgents($: EngineInterface) {
  const running = (await $.agent.list()).filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')
  if (running.length === 0) return
  const ms = await $.clock.now()
  await apply($, cur =>
    running.reduce(
      (p, a) => addParallel(p, { id: `agent:${a.id}`, title: `${a.type}: ${a.description}`, kind: 'agent', ref: null, start: ms, end: null }),
      cur,
    ),
  )
}

async function checkAgents($: EngineInterface) {
  const p = await read($, plan)
  if (!p?.tasks.some(t => t.kind === 'agent' && t.status === 'running')) return
  for (const a of await $.agent.list()) {
    if (a.status === 'completed' || a.status === 'failed' || a.status === 'killed') {
      await close($, t => t.id === `agent:${a.id}`, a.status)
    }
  }
}

type Notice = { id?: string; status?: string; toolUseId?: string; durationMs?: number }

export const register: Register = on => {
  const warned = new Set<string>()
  // Finish notices seen while drawing the transcript: writing there is refused, so the 2 s timer applies them after
  const notices: Notice[] = []

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'plan',
      isDeferred: false,
      description:
        'Registers the work plan as a task tree with ETAs, shown to the user in a band above the prompt with the ' +
        'real clock. Use it before starting any request with 2 or more steps, and again when the plan changes (it ' +
        'replaces the previous one, keeping the times of tasks with the same id). parent = id of the task this one ' +
        'depends on (it starts only when the parent is done); no parent = independent. min/max = range in wall-clock ' +
        'minutes. status "question" = waits on an answer from the user (write the question in waitingOn); "waiting" = ' +
        `waits on something outside. Once a question is answered, change its status with ${TOOL_TASK}. ` +
        'The answer carries the calibration factor from your history: apply it to your ranges.',
      inputSchema: {
        type: 'object',
        required: ['goal', 'tasks'],
        properties: {
          goal: { type: 'string', description: "The user's request, in one line" },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'title', 'min', 'max'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                parent: { type: 'string' },
                min: { type: 'number' },
                max: { type: 'number' },
                status: { type: 'string', enum: STATUSES },
                waitingOn: { type: 'string', description: 'status = waiting: what or who the task waits on; status = question: the question to the user' },
              },
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'task',
      isDeferred: false,
      description:
        `Updates one task of the plan registered with ${TOOL_PLAN}. Call it with status "running" when each task ` +
        'starts and "done" when it ends: the real clock and the calibration depend on these two calls.',
      inputSchema: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: STATUSES },
          waitingOn: { type: 'string', description: 'What the task waits on, or the question to the user when status = question' },
          min: { type: 'number', description: 'New range, when re-estimating' },
          max: { type: 'number' },
        },
      },
    })

    // The command is an extra: if it fails, the tools and the clock go on
    try {
      await $.command.register({ name: 'eta', description: 'Show or hide the ETA band' })
    } catch {}

    try {
      const tz = await $.process.run(['date', '+%z'])
      const m = /^([+-])(\d{2})(\d{2})$/.exec(tz.stdout.trim())
      if (m) offsetMin = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
    } catch {}

    try {
      await migrate($)
    } catch {}

    $.clock.every(2_000, () => {
      if (notices.length === 0) return
      const batch = notices.splice(0)
      void (async () => {
        for (const n of batch) {
          try {
            await close(
              $,
              t => (n.toolUseId != null && t.ref === n.toolUseId) || (n.id != null && t.id.endsWith(`:${n.id}`)),
              n.status,
              n.durationMs,
            )
          } catch {}
        }
      })()
    })

    const startMs = await $.clock.now()
    await update($, now, () => startMs)
    try {
      await seedAgents($)
    } catch {}
    $.clock.every(TICK_MS, () => {
      void (async () => {
        const ms = await $.clock.now()
        await update($, now, () => ms)
        try {
          await checkAgents($)
        } catch {}
        const p = await read($, plan)
        for (const t of p?.tasks ?? []) {
          if (overdue(t, ms) && !warned.has(t.id)) {
            warned.add(t.id)
            $.ui.toast(`⚠️ ${t.title} went past ${range(t.min, t.max)}`)
          }
        }
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'eta' }, async $ => {
    await update($, open, v => !v)
    return { text: (await read($, open)) ? 'ETA: band shown.' : 'ETA: band hidden.' }
  })

  on('tool.call', { tool: TOOL_PLAN }, async ($, e) => {
    try {
      const goal = str(e.goal)
      const raw = Array.isArray(e.tasks) ? (e.tasks as Record<string, unknown>[]) : null
      if (!goal || !raw || raw.length === 0) return { deny: 'Give a goal and at least one task.' }

      const ms = await $.clock.now()
      const previous = (await read($, plan))?.tasks ?? []
      const byId = new Map(previous.map(t => [t.id, t]))
      const byTitle = new Map(previous.map(t => [t.title, t]))
      const used = new Set<string>()
      const tasks: Task[] = []
      for (const b of raw) {
        const id = str(b.id)
        const title = str(b.title)
        const min = num(b.min)
        const max = num(b.max)
        if (!id || !title || min == null || max == null) return { deny: `Invalid task: ${JSON.stringify(b)}` }
        // Same id, or the mirrored task with the same title: inherits times and ref
        const old = byId.get(id) ?? byTitle.get(title)
        if (old) used.add(old.id)
        const st = status(b.status) ?? old?.status ?? 'next'
        const base: Task = {
          id, title, parent: str(b.parent), min: Math.min(min, max), max: Math.max(min, max), status: old?.status ?? st,
          waitingOn: str(b.waitingOn), estimated: true, ref: old?.ref ?? null,
          start: old?.start ?? null, end: old?.end ?? null,
        }
        tasks.push(transition(base, st, ms))
      }
      // Mirrored tasks the plan did not name stay, until TodoWrite/TaskUpdate or their end removes them
      const rest = previous.filter(t => mirrored(t) && !used.has(t.id))
      const { after } = await apply($, () => ({ goal, tasks: [...tasks, ...rest] }))

      return { result: planText(after, ms, await factor($)) }
    } catch (err) {
      return { deny: `eta: ${String(err)}` }
    }
  })

  on('tool.call', { tool: TOOL_TASK }, async ($, e) => {
    try {
      const p = await read($, plan)
      const id = str(e.id)
      const st = status(e.status)
      const target = p?.tasks.find(t => t.id === id)
      if (!p || !target || !st) return { deny: `Plan or task not found: register it with ${TOOL_PLAN}.` }

      const min = num(e.min)
      const max = num(e.max)
      if (min != null && max != null) warned.delete(target.id)
      const { after, ms } = await apply($, (cur, ms) => ({
        ...cur,
        tasks: cur.tasks.map(x => {
          if (x.id !== target.id) return x
          const t: Task = { ...x, waitingOn: str(e.waitingOn) ?? x.waitingOn }
          if (min != null && max != null) Object.assign(t, { min: Math.min(min, max), max: Math.max(min, max), estimated: true })
          return transition(t, st, ms)
        }),
      }))
      const t = after.tasks.find(x => x.id === target.id)!
      const note = st === 'done' && t.start != null ? ` — took ${took(t, ms)} (estimated ${rangeOf(t)})` : ''

      return { result: `${ICON[st]} ${t.title}${note}` }
    } catch (err) {
      return { deny: `eta: ${String(err)}` }
    }
  })

  // ── mirror of Claude Code's own task lists ───────────────────────────────
  // The mirror never gets in the tool's way: any error here is swallowed and the original result returns

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if ('deny' in r || r.isError) return r
      const todos = (e as { todos?: { content?: unknown; status?: unknown }[] }).todos ?? []
      await apply($, (cur, ms) => {
        const byTitle = new Map(cur.tasks.map(t => [t.title, t]))
        const seen = new Set<string>()
        const tasks = [...cur.tasks]
        for (const td of todos) {
          const title = str(td.content)
          const st = FROM_TODO[String(td.status)]
          if (!title || !st) continue
          const old = byTitle.get(title)
          if (old) {
            seen.add(old.id)
            tasks[tasks.indexOf(old)] = transition(old, st, ms)
          } else {
            const t = transition(blank(`todo:${title}`, title), st, ms)
            seen.add(t.id)
            tasks.push(t)
          }
        }
        // TodoWrite sends the whole list: what came from it and left the list leaves the tree
        return { ...cur, tasks: tasks.filter(t => !t.id.startsWith('todo:') || seen.has(t.id)) }
      })
    } catch {}
    return r
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if ('deny' in r || r.isError) return r
      const created = (r.result as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task
      const ref = str(created?.id)
      const title = str(created?.subject) ?? str((e as { subject?: unknown }).subject)
      if (!ref || !title) return r
      await apply($, cur => {
        const old = cur.tasks.find(t => t.title === title && t.ref == null)
        return {
          ...cur,
          tasks: old ? cur.tasks.map(t => (t === old ? { ...t, ref } : t)) : [...cur.tasks, blank(`task:${ref}`, title, ref)],
        }
      })
    } catch {}
    return r
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if ('deny' in r || r.isError) return r
      const u = e as { taskId?: unknown; status?: unknown; subject?: unknown; addBlockedBy?: unknown }
      const ref = str(u.taskId)
      if (!ref) return r
      await apply($, (cur, ms) => {
        if (u.status === 'deleted') return { ...cur, tasks: cur.tasks.filter(t => t.ref !== ref) }
        const blocker = Array.isArray(u.addBlockedBy) ? str(u.addBlockedBy[0]) : null
        const parent = blocker ? (cur.tasks.find(t => t.ref === blocker)?.id ?? null) : null
        return {
          ...cur,
          tasks: cur.tasks.map(t => {
            if (t.ref !== ref) return t
            let x: Task = { ...t, title: str(u.subject) ?? t.title, parent: parent ?? t.parent }
            const st = FROM_TODO[String(u.status)]
            if (st) x = transition(x, st, ms)
            return x
          }),
        }
      })
    } catch {}
    return r
  })

  // ── subagents and background processes ───────────────────────────────────

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if ('deny' in r || r.isError) return r
      const res = r.result as { agentId?: unknown; totalDurationMs?: unknown } | undefined
      const id = str(res?.agentId)
      if (!id) return r
      const a = e as { description?: unknown; subagent_type?: unknown }
      // In the foreground the call returns only once the agent is done, already carrying its duration
      const durationMs = typeof res?.totalDurationMs === 'number' ? res.totalDurationMs : null
      const ms = await $.clock.now()
      await apply($, cur =>
        addParallel(cur, {
          id: `agent:${id}`, title: `${str(a.subagent_type) ?? 'agent'}: ${str(a.description) ?? 'subagent'}`,
          kind: 'agent', ref: e.tool_use_id, start: durationMs != null ? ms - durationMs : ms, end: durationMs != null ? ms : null,
        }),
      )
    } catch {}
    return r
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if ('deny' in r || r.isError) return r
      const id = str((r.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId)
      if (!id) return r
      const b = e as { command?: unknown; description?: unknown }
      const ms = await $.clock.now()
      await apply($, cur =>
        addParallel(cur, {
          id: `process:${id}`, title: str(b.description) ?? cut(str(b.command) ?? 'process', 60),
          kind: 'process', ref: e.tool_use_id, start: ms, end: null,
        }),
      )
    } catch {}
    return r
  })

  // A subagent finished a turn: check the list for whether it is done for good
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if ((e as { agentId?: string }).agentId) {
      try {
        await checkAgents($)
      } catch {}
    }
    return r
  })

  // A background task's finish notice arrives as a message in the transcript: it closes that task
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const task = (e.props as { task?: Notice }).task
    if (task && (task.id || task.toolUseId)) notices.push({ ...task })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, plan)
    if (e.props.hasSurvey || !p || p.tasks.every(t => t.status === 'done') || !(await read($, open))) return next(e)

    // `now` is read only to redraw on each tick; the time comes from the clock, or it would lag up to one tick
    await read($, now)
    const ms = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const width = Number.isFinite(e.props.bodyColumns) ? Math.max(30, Math.floor(e.props.bodyColumns)) : 100
    const waiting = p.tasks.filter(t => t.status === 'waiting')
    const rows = tree(p, ms)
    const qs = questionRows(p, ms)

    const info = ` ${headline(p, ms)}`
    const draw = (r: Row) => {
      const st = statusText(r)
      const room = width - 1 - r.prefix.length - 2 - (st ? st.length + 3 : 0)
      return (
        <Text dimColor={r.dim}>
          <Text dimColor>{r.prefix}</Text>
          <Text color={r.icon.color} dimColor={r.icon.dim} bold={r.icon.bold}>{r.icon.text}</Text>
          {` ${cut(r.title, Math.max(12, room))}`}
          {st ? ' — ' : ''}
          {r.status.map(s => (
            <Text color={s.color} dimColor={s.dim}>{s.text}</Text>
          ))}
        </Text>
      )
    }
    const waitList = waiting.map(t => `${t.title}${t.waitingOn ? ` (${t.waitingOn})` : ''}`).join(' · ')

    return (
      <Box flexDirection="column">
        {/* Full-width rule: sets the band apart from the transcript above */}
        <Text dimColor>{'─'.repeat(width)}</Text>
        <Text>
          <Text bold>⏱ {cut(p.goal, Math.max(10, width - info.length - 6))}</Text>
          <Text dimColor>{info}</Text>
        </Text>
        <Text> </Text>
        {waiting.length > 0 ? (
          <Text color="permission">{cut(`${ICON.waiting} ${waiting.length} waiting: ${waitList}`, width - 1)}</Text>
        ) : null}
        {rows.map(draw)}
        {qs.length > 0 ? <Text> </Text> : null}
        {qs.map(draw)}
      </Box>
    )
  })
}
