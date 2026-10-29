import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000

const BAND = {
  plugin: 'eta',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const HEADER = { type: 'Text', text: /^⏱/ } as const

type On = Parameters<Parameters<typeof test>[1]>[1]

// 1000 min after the epoch = 16:40 UTC; at -0300, 13:40 local
function timeZone(on: On) {
  on('process.run', () => ({ value: { exitCode: 0, stdout: '-0300\n', stderr: '', isStdoutTruncated: false } }))
}

async function start($: Parameters<Parameters<typeof test>[1]>[0], on: On) {
  mock.clock(on, { now: 1_000 * MIN })
  mock.store(on)
  timeZone(on)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__eta__${(e as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

const PLAN = {
  tool: 'mcp__eta__plan',
  goal: 'Update the site',
  tasks: [
    { id: 'data', title: 'Regenerate JSON', min: 5, max: 10 },
    { id: 'readme', title: 'README', parent: 'data', min: 5, max: 10 },
    { id: 'commit', title: 'Commit', parent: 'readme', min: 2, max: 5 },
  ],
} as const

test('plan as a tree, real clock and calibration', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 * MIN })
  mock.store(on, { history: Array.from({ length: 5 }, () => ({ estimated: 5, actual: 10 })) })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__eta__${(e as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  timeZone(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? JSON.stringify(e)))
    return { value: {} }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const text = String(((await $.tool.call(PLAN)) as { result?: unknown }).result)
  expect(text).toContain('🎯 Update the site — ⏱ 12–25 min left · ends ~13:58')
  // Each dependency indents under its parent's icon
  expect(text).toContain('\n○ Regenerate JSON — 5–10 min\n└ ○ README — 5–10 min\n  └ ○ Commit — 2–5 min\n')
  expect(text).toContain('2.0×')

  await $.tool.call({ tool: 'mcp__eta__task', id: 'data', status: 'running' })
  await clock.advance(12 * MIN)
  expect(toasts.join(' ')).toContain('Regenerate JSON went past 5–10 min')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Regenerate JSON/ }))?.text).toBe('! Regenerate JSON — +2 min over')
  await ui.unmount()

  const done = await $.tool.call({ tool: 'mcp__eta__task', id: 'data', status: 'done' })
  expect(String((done as { result?: unknown }).result)).toBe('✓ Regenerate JSON — took 12 min (estimated 5–10 min)')
  const replan = String(((await $.tool.call(PLAN)) as { result?: unknown }).result)
  expect(replan).toContain('n=6')
  expect(replan).toContain('✓ Regenerate JSON — took 12 min')
})

test('with no plan the band is left to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('TodoWrite becomes a tree on its own and matches the plan by title', async ($, on) => {
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  await start($, on)

  await $.tool.call(PLAN)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Regenerate JSON', status: 'in_progress', activeForm: 'Regenerating' },
      { content: 'Run tests', status: 'pending', activeForm: 'Testing' },
    ],
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find(HEADER))?.text).toContain('✓ 0/4 · ◷ ~19 min left · +1 unestimated · ✓ ends ~13:58')
  expect((await ui.find({ type: 'Text', text: /Regenerate JSON/ }))?.text).toBe('▶ Regenerate JSON — ────────  0% · 5–10 min left')
  await ui.unmount()

  // The whole list again: 'Run tests' leaves, the plan's task stays
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Regenerate JSON', status: 'completed', activeForm: 'x' }] })
  const text = String(((await $.tool.call(PLAN)) as { result?: unknown }).result)
  expect(text).toContain('✓ Regenerate JSON')
  expect(text).not.toContain('Run tests')
})

test('TaskCreate and TaskUpdate join the tree with dependencies', async ($, on) => {
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, (_, e) => ({
    result: { task: { id: String(++n), subject: (e as { subject: string }).subject } },
  }))
  on('tool.call', { tool: 'TaskUpdate' }, (_, e) => ({
    result: { success: true, taskId: (e as { taskId: string }).taskId, updatedFields: [] },
  }))
  await start($, on)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Download data', description: 'x' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Draw chart', description: 'y' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', addBlockedBy: ['1'] })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Download data/ }))?.text).toBe('▶ Download data — 0 min')
  expect((await ui.find({ type: 'Text', text: /Draw chart/ }))?.text).toBe('└ ○ Draw chart — ?')
  await ui.unmount()

  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'deleted' })
  const ui2 = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui2.find({ type: 'Text', text: /Draw chart/ })).toBeUndefined()
  await ui2.unmount()
})

test('compact progress: range midpoint, hours and overrun', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 * MIN })
  mock.store(on)
  timeZone(on)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__eta__${(e as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({
    tool: 'mcp__eta__plan',
    goal: 'x',
    tasks: [
      { id: 'a', title: 'Short', min: 5, max: 10, status: 'running' },
      { id: 'b', title: 'Long', min: 2400, max: 3600, status: 'running' },
    ],
  })
  await clock.advance(7 * MIN)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Short/ }))?.text).toBe('▶ Short — ━━━━━━━─  93% · up to 3 min left')
  await ui.unmount()

  await clock.advance(68 * MIN)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Long/ }))?.text).toBe('▶ Long — ────────  2% · ~49 h (39–59) left')
  expect((await ui.find({ type: 'Text', text: /Short/ }))?.text).toBe('! Short — stalled? +1:05 h over')
  await ui.unmount()
})

test('a task started after the last tick does not break the band', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 * MIN })
  mock.store(on)
  timeZone(on)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__eta__${(e as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({
    tool: 'mcp__eta__plan',
    goal: 'x',
    tasks: [
      { id: 'f', title: 'finished', min: 0, max: 0, status: 'done' },
      { id: 'l', title: 'Long', min: 900, max: 2400 },
    ],
  })
  await clock.advance(30_000)
  await $.tool.call({ tool: 'mcp__eta__task', id: 'l', status: 'running' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Long/ }))?.text).toBe('▶ Long — ────────  0% · ~28 h (15–40) left')
  await ui.unmount()
})

test('the full tree always shows and /eta shows and hides the band', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 * MIN })
  mock.store(on)
  timeZone(on)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__eta__${(e as { name: string }).name}` } }))
  on('command.register', () => ({ value: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // The engine draws the empty band when the mod lets it through
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({
    tool: 'mcp__eta__plan',
    goal: 'Migrate the database, reprocess the old files and ship v2 with a rather long title',
    tasks: [
      { id: 'staging', title: 'Data in staging', min: 5, max: 10, status: 'done' },
      { id: 'reproc', title: 'reprocess_2025', parent: 'staging', min: 60, max: 120, status: 'running' },
      { id: 'attach', title: 'attach', parent: 'reproc', min: 30, max: 90 },
      { id: 'views', title: 'views', parent: 'attach', min: 20, max: 40 },
      { id: 'import', title: 'Import data', min: 240, max: 1440, status: 'running' },
      { id: 'ok', title: 'report format', min: 60, max: 120, status: 'waiting', waitingOn: 'upload confirms' },
    ],
  })
  await clock.advance(10 * MIN)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const header = (await ui.find(HEADER))?.text ?? ''
  // The two running tasks run together (Import counts, 230–1430); the queue adds up in series (attach, views, report: 110–250)
  expect(header).toContain('✓ 1/6 · ◷ ~17 h left · ✓ ends ~tomorrow 06:40')
  expect(header.startsWith('⏱ Migrate the database')).toBe(true)
  expect(header).toContain('…')
  expect(header.length).toBeLessThanOrEqual(100)
  expect((await ui.find({ type: 'Text', text: /waiting:/ }))?.text).toBe('◷ 1 waiting: report format (upload confirms)')
  expect((await ui.find({ type: 'Text', text: /Data in staging/ }))?.text).toBe('✓ Data in staging')
  expect((await ui.find({ type: 'Text', text: /reprocess_2025/ }))?.text).toBe('└ ▶ reprocess_2025 — ────────  11% · ~1:20 h (0:50–1:50) left')
  expect((await ui.find({ type: 'Text', text: /attach/ }))?.text).toBe('  └ ○ attach — 0:30–1:30 h')
  expect((await ui.find({ type: 'Text', text: /views/ }))?.text).toBe('    └ ○ views — 20–40 min')
  await ui.unmount()

  expect((await $.command.run({ command: 'eta', args: '' }) as { text?: string }).text).toBe('ETA: band hidden.')
  const hidden = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await hidden.find(HEADER)).toBeUndefined()
  expect((await hidden.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await hidden.unmount()

  expect((await $.command.run({ command: 'eta', args: '' }) as { text?: string }).text).toBe('ETA: band shown.')
  const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await again.find({ type: 'Text', text: /views/ }))?.text).toBe('    └ ○ views — 20–40 min')
  await again.unmount()
})

test('questions sit below the tree and return to it once answered', async ($, on) => {
  await start($, on)
  await $.tool.call({
    tool: 'mcp__eta__plan',
    goal: 'x',
    tasks: [
      { id: 'a', title: 'Import', min: 60, max: 120, status: 'running' },
      { id: 'q', title: 'Report format', parent: 'a', min: 60, max: 120, status: 'question', waitingOn: 'Option A or B?' },
      { id: 'q2', title: 'Build report', parent: 'q', min: 10, max: 20 },
    ],
  })
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find(HEADER))?.text).toContain('✓ 0/3 · ◷ ~1:45 h left · +1 pending · ✓ ends ~15:25')
  expect((await ui.find({ type: 'Text', text: /Report format/ }))?.text).toBe('? Report format — Option A or B? · then 1–2 h · +1 after')
  expect(await ui.find({ type: 'Text', text: /Build report/ })).toBeUndefined()
  await ui.unmount()

  await $.tool.call({ tool: 'mcp__eta__task', id: 'q', status: 'next' })
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Report format/ }))?.text).toBe('└ ○ Report format — 1–2 h')
  expect((await ui.find({ type: 'Text', text: /Build report/ }))?.text).toBe('  └ ○ Build report — 10–20 min')
  await ui.unmount()
})

test('subagents and background processes join with their own icon and leave when done', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 * MIN })
  mock.store(on)
  timeZone(on)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__eta__${(e as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const a1 = { id: 'a1', description: 'find the CSV', type: 'Explore', status: 'running' }
  let agents: (typeof a1)[] = []
  on('agent.list', () => ({ value: agents }) as never)
  on('tool.call', { tool: 'Agent' }, () => ({ result: { agentId: 'a1' } }) as never)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }) as never)
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>notice</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'mcp__eta__plan', goal: 'x', tasks: [{ id: 'imp', title: 'Import data', min: 60, max: 120, status: 'running' }] })
  await $.tool.call({ tool: 'Agent', description: 'find the CSV', subagent_type: 'Explore', prompt: 'p' } as never)
  agents = [a1]
  await $.tool.call({ tool: 'Bash', command: 'bun run import.ts 2024-01', run_in_background: true } as never)
  await clock.advance(3 * MIN)

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Explore/ }))?.text).toBe('└ ◆ Explore: find the CSV — 3 min')
  expect((await ui.find({ type: 'Text', text: /import\.ts/ }))?.text).toBe('└ ◐ bun run import.ts 2024-01 — 3 min')
  expect((await ui.find(HEADER))?.text).not.toContain('unestimated')
  await ui.unmount()

  // The agent ends (the list says so) and the process's notice arrives as a message in the transcript
  agents = [{ ...a1, status: 'completed' }]
  await clock.advance(MIN)
  const msg = await $.ui.mount({ plugin: 'eta', surface: 'terminal', component: 'UserMessage', props: { task: { id: 'b1', status: 'failed' } } } as never)
  await msg.unmount()
  await clock.advance(2_000)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Explore/ }))?.text).toBe('└ ✓ Explore: find the CSV — took 4 min')
  expect((await ui.find({ type: 'Text', text: /import\.ts/ }))?.text).toBe('└ ✕ bun run import.ts 2024-01 — failed · took 4 min')
  await ui.unmount()

  // A few minutes later they leave the tree
  await clock.advance(6 * MIN)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Explore/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /import\.ts/ })).toBeUndefined()
  await ui.unmount()
})

test('on load, subagents already running join the tree', async ($, on) => {
  mock.clock(on, { now: 1_000 * MIN })
  mock.store(on)
  timeZone(on)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__eta__${(e as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [
    { id: 'a9', description: 'review the README', type: 'general-purpose', status: 'running' },
    { id: 'a8', description: 'stale', type: 'Explore', status: 'completed' },
  ] }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /review/ }))?.text).toBe('◆ general-purpose: review the README — 0 min')
  expect(await ui.find({ type: 'Text', text: /stale/ })).toBeUndefined()
  await ui.unmount()
})

test('a plan and history stored by the Portuguese version are migrated', async ($, on) => {
  mock.clock(on, { now: 1_000 * MIN })
  mock.store(on, { historico: [{ estimado: 5, real: 10 }] })
  timeZone(on)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__eta__${(e as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // What the Portuguese version stored stays through the reload
  const legacy = {
    objetivo: 'Old goal',
    tarefas: [
      { id: 'a', titulo: 'Old task', pai: null, min: 5, max: 10, estado: 'andamento', esperando: null, estimada: true, ref: null, inicio: 1_000 * MIN, fim: null },
      { id: 'q', titulo: 'Old question', pai: null, min: 5, max: 10, estado: 'pergunta', esperando: 'A or B?', estimada: true, ref: null, inicio: null, fim: null },
    ],
  }
  let legacyRead = false
  on('state.get', ($, e, next) => {
    if ((e as { key?: string }).key !== 'plano' || legacyRead) return next(e)
    legacyRead = true
    return { value: { value: { shape: 'plano-2', value: legacy }, version: 1 } } as never
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find(HEADER))?.text?.startsWith('⏱ Old goal')).toBe(true)
  expect((await ui.find({ type: 'Text', text: /Old task/ }))?.text).toBe('▶ Old task — ────────  0% · 5–10 min left')
  expect((await ui.find({ type: 'Text', text: /Old question/ }))?.text).toBe('? Old question — A or B? · then 5–10 min')
  await ui.unmount()
  // The old calibration sample counts in the new history
  const text = String(((await $.tool.call({ tool: 'mcp__eta__plan', goal: 'x', tasks: [{ id: 'z', title: 'z', min: 1, max: 2 }] })) as { result?: unknown }).result)
  expect(text).toContain('Calibration: 1/5 tasks measured')
})
