import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { Estado, Plano, Tarefa } from '../types'

// Troque o shape quando os campos de Tarefa mudarem: recusa o que a versão anterior guardou
const plano = atom({ plugin: 'eta', key: 'plano' } as const, null, { shape: 'plano-2' })
const agora = atom({ plugin: 'eta', key: 'agora' } as const, 0)
// A faixa aparece ou some, alternada pelo /eta; a árvore é sempre a completa
const aberta = atom({ plugin: 'eta', key: 'aberta' } as const, true)

const TOOL_PLANO = 'mcp__eta__plano'
const TOOL_TAREFA = 'mcp__eta__tarefa'
const OBJETIVO_PADRAO = 'Tarefas da sessão'
const TICK_MS = 60_000
const HISTORICO_MAX = 200
const MIN_AMOSTRAS = 5
const BARRA = 8
// Estouro a partir do qual a tarefa provavelmente só não foi encerrada
const PARADA_MIN = 30
// Subagente ou processo que terminou fica na árvore por esse tempo, depois sai
const LIMPA_MS = 5 * 60_000

// Símbolos de uma coluna só, para os títulos alinharem; a cor diferencia os estados
const ICONE: Record<Estado, string> = {
  feita: '✓', andamento: '▶', proxima: '○', esperando: '◷', bloqueada: '✕', pergunta: '?',
}

type Amostra = { estimado: number; real: number }
type Parte = { texto: string; cor?: Color; apagado?: boolean; negrito?: boolean }
type Linha = { prefixo: string; icone: Parte; titulo: string; status: Parte[]; apagada: boolean }

// ── tempo ────────────────────────────────────────────────────────────────

// h:mm, sem o :00 das horas cheias
const hm = (min: number) => {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return m === 0 ? `${h}` : `${h}:${String(m).padStart(2, '0')}`
}
// Uma duração só, curta: 12 min, 1:20 h, 20 h
// De 10 h para cima os minutos são ruído: arredonda para a hora
const dur = (min: number) => {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m} min`
  return m >= 600 ? `${Math.round(m / 60)} h` : `${hm(m)} h`
}

function faixa(a: number, b: number): string {
  const lo = Math.max(0, Math.round(a))
  const hi = Math.max(lo, Math.round(b))
  if (hi < 60) return lo === hi ? `${hi} min` : `${lo}–${hi} min`
  if (hi >= 600) {
    const [a, b] = [Math.round(lo / 60), Math.round(hi / 60)]
    return a === b ? `${b} h` : `${a}–${b} h`
  }
  return lo === hi ? `${hm(hi)} h` : `${hm(lo)}–${hm(hi)} h`
}

// Faixa larga demais diz pouco: o meio na frente e a faixa entre parênteses, ~14 h (4–24)
function provavel(lo: number, hi: number): string {
  if (hi < 60 || hi <= lo * 1.5) return faixa(lo, hi)
  return `~${dur((lo + hi) / 2)} (${faixa(lo, hi).replace(/ (min|h)$/, '')})`
}

// Subagentes e processos em segundo plano: trabalho em paralelo de verdade, com ícone próprio enquanto rodam
const PARALELA: Record<NonNullable<Tarefa['tipo']>, { texto: string; cor: Color }> = {
  agente: { texto: '◆', cor: 'claude' },
  processo: { texto: '◐', cor: 'planMode' },
}
const sumiu = (t: Tarefa, ms: number) => t.tipo != null && t.estado !== 'andamento' && t.fim != null && ms - t.fim > LIMPA_MS

const decorrido = (t: Tarefa, ms: number) => (t.inicio == null ? 0 : Math.max(0, ((t.fim ?? ms) - t.inicio) / 60_000))
const atrasada = (t: Tarefa, ms: number) => t.estimada && t.estado === 'andamento' && decorrido(t, ms) > t.max
const parada = (t: Tarefa, ms: number) => atrasada(t, ms) && decorrido(t, ms) - t.max >= Math.max(PARADA_MIN, t.max)
const faixaDe = (t: Tarefa) => (t.estimada ? faixa(t.min, t.max) : '?')
const levou = (t: Tarefa, ms: number) => dur(decorrido(t, ms))

// Tarefa em andamento: barra e % sobre o meio da faixa (até 99%), e quanto falta; passou do teto, só o estouro
function progresso(t: Tarefa, ms: number): Parte[] {
  const d = decorrido(t, ms)
  if (!t.estimada) return [{ texto: dur(d), cor: 'suggestion' }]
  if (d > t.max) return [{ texto: `${parada(t, ms) ? 'parada? ' : ''}+${dur(d - t.max)} além`, cor: 'warning' }]
  const meio = (t.min + t.max) / 2 || t.max || 1
  const pct = Math.min(99, Math.floor((d / meio) * 100))
  const cheias = Math.max(0, Math.min(BARRA, Math.floor((pct / 100) * BARRA) || 0))
  const falta = d >= t.min ? `até ${dur(t.max - d)}` : `faltam ${provavel(t.min - d, t.max - d)}`
  return [
    { texto: '━'.repeat(cheias), cor: 'suggestion' },
    { texto: '─'.repeat(BARRA - cheias), apagado: true },
    { texto: `  ${pct}% · ${falta}`, cor: 'suggestion' },
  ]
}

// ── calibração ───────────────────────────────────────────────────────────

async function fator($: { store: { get: (k: string) => Promise<unknown> } }) {
  const hist = ((await $.store.get('historico')) ?? []) as Amostra[]
  if (hist.length < MIN_AMOSTRAS) return { fator: null, n: hist.length }
  const r = hist.map(a => a.real / a.estimado).sort((x, y) => x - y)
  return { fator: r[Math.floor(r.length / 2)] ?? null, n: hist.length }
}

// ── plano ────────────────────────────────────────────────────────────────

// Um agente faz uma coisa de cada vez: o que está na fila soma em série. Só as em andamento correm
// juntas, então delas vale a mais longa
function restante(p: Plano, ms: number): [number, number] {
  let lo = 0
  let hi = 0
  let rodaLo = 0
  let rodaHi = 0
  for (const t of p.tarefas) {
    // Pergunta não conta enquanto não for respondida: entra no resto como "dependem de você"
    if (t.estado === 'feita' || t.estado === 'pergunta' || !t.estimada) continue
    if (t.estado === 'andamento') {
      const gasto = decorrido(t, ms)
      rodaLo = Math.max(rodaLo, t.min - gasto)
      rodaHi = Math.max(rodaHi, t.max - gasto)
    } else {
      lo += t.min
      hi += t.max
    }
  }
  return [lo + Math.max(0, rodaLo), hi + Math.max(0, rodaHi)]
}

function iconeDe(t: Tarefa, ms: number): Parte {
  if (atrasada(t, ms)) return { texto: '!', cor: 'warning' }
  if (t.tipo && t.estado === 'andamento') return PARALELA[t.tipo]
  const texto = ICONE[t.estado]
  if (t.estado === 'andamento' || t.estado === 'feita') return { texto, cor: 'success' }
  if (t.estado === 'esperando') return { texto, cor: 'permission' }
  if (t.estado === 'bloqueada') return { texto, cor: 'error' }
  if (t.estado === 'pergunta') return { texto, cor: 'suggestion', negrito: true }
  return { texto, cor: 'warning' }
}

function statusDe(t: Tarefa, ms: number): Parte[] {
  // Feita sem duração real (já nasceu feita) não tem o que mostrar
  if (t.estado === 'feita') return decorrido(t, ms) >= 1 ? [{ texto: `levou ${levou(t, ms)}` }] : []
  if (t.estado === 'andamento') return progresso(t, ms)
  if (t.tipo && t.estado === 'bloqueada') return [{ texto: `${t.esperando ?? 'falhou'} · levou ${levou(t, ms)}`, cor: 'error' }]
  if (t.estado === 'esperando') {
    const depois = t.estimada && t.max > 0 ? ` · depois ${faixaDe(t)}` : ''
    return [{ texto: `? ${t.esperando ?? ''}`.trim() + depois, cor: 'permission' }]
  }
  if (t.estado === 'pergunta') {
    const depois = t.estimada && t.max > 0 ? ` · depois ${faixaDe(t)}` : ''
    return [{ texto: t.esperando ?? 'aguarda sua resposta', cor: 'suggestion' }, { texto: depois, apagado: true }]
  }
  return [{ texto: faixaDe(t), apagado: true }]
}

// Perguntas ficam fora da árvore, numa seção abaixo dela; o que depende de uma pergunta espera a resposta e
// sai junto. Respondida (outro estado), a tarefa volta para a árvore no lugar dela
function perguntas(p: Plano): { pergunta: Tarefa; presas: Set<string> }[] {
  const filhos = new Map<string, Tarefa[]>()
  for (const t of p.tarefas) if (t.pai != null) filhos.set(t.pai, [...(filhos.get(t.pai) ?? []), t])
  return p.tarefas
    .filter(t => t.estado === 'pergunta')
    .map(q => {
      const presas = new Set<string>()
      const pilha = [q.id]
      while (pilha.length > 0) {
        for (const f of filhos.get(pilha.pop()!) ?? []) {
          if (f.id === q.id || presas.has(f.id)) continue
          presas.add(f.id)
          pilha.push(f.id)
        }
      }
      return { pergunta: q, presas }
    })
}

function linhasPerguntas(p: Plano, ms: number): Linha[] {
  return perguntas(p).map(({ pergunta: t, presas }) => {
    const n = p.tarefas.filter(x => presas.has(x.id) && x.estado !== 'feita').length
    const status = statusDe(t, ms)
    if (n > 0) status.push({ texto: ` · +${n} depois`, apagado: true })
    return { prefixo: '', icone: iconeDe(t, ms), titulo: t.titulo, status, apagada: false }
  })
}

// └─ recuado = depende da tarefa-mãe; tarefas no mesmo recuo são independentes entre si
function arvore(p: Plano, ms: number): Linha[] {
  const fora = new Set([...perguntas(p).flatMap(q => [q.pergunta.id, ...q.presas]), ...p.tarefas.filter(t => sumiu(t, ms)).map(t => t.id)])
  const tarefas = p.tarefas.filter(t => !fora.has(t.id))
  const ids = new Set(tarefas.map(t => t.id))
  const filhos = new Map<string | null, Tarefa[]>()
  for (const t of tarefas) {
    const pai = t.pai != null && ids.has(t.pai) ? t.pai : null
    filhos.set(pai, [...(filhos.get(pai) ?? []), t])
  }
  const linha = (t: Tarefa, prefixo: string): Linha => (
    { prefixo, icone: iconeDe(t, ms), titulo: t.titulo, status: statusDe(t, ms), apagada: t.estado === 'feita' }
  )

  const out: Linha[] = []
  // └ fica sob o ícone da mãe: cada nível 2 colunas adiante
  const recuo = (n: number) => (n === 0 ? '' : `${' '.repeat(2 * (n - 1))}└ `)
  // Um pai que aponta para um descendente fecharia um ciclo: cada tarefa sai uma vez só
  const vistas = new Set<string>()
  const desce = (lista: Tarefa[], nivel: number) => {
    for (const t of lista) {
      if (vistas.has(t.id)) continue
      vistas.add(t.id)
      out.push(linha(t, recuo(nivel)))
      desce(filhos.get(t.id) ?? [], nivel + 1)
    }
  }
  desce(filhos.get(null) ?? [], 0)
  return out
}

const textoStatus = (l: Linha) => l.status.map(s => s.texto).join('')
const textoLinha = (l: Linha) => `${l.prefixo}${l.icone.texto} ${l.titulo}${l.status.length ? ` — ${textoStatus(l)}` : ''}`

// Corta em n colunas com …, contando por caractere
function corta(s: string, n: number): string {
  const cs = Array.from(s)
  if (cs.length <= n) return s
  return n <= 1 ? '…' : `${cs.slice(0, n - 1).join('').trimEnd()}…`
}

// Hora local de término: o ambiente do mod não sabe o fuso, então o offset vem do `date +%z` da máquina
let offsetMin = 0
const local = (ms: number) => new Date(ms + offsetMin * 60_000)
const relogio = (ms: number) => {
  const d = local(ms)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
// hoje 15:22, amanhã 04:46 ou 31/10 09:00
function quando(alvo: number, ms: number): string {
  const dia = (x: number) => Math.floor(local(x).getTime() / 86_400_000)
  const dd = dia(alvo) - dia(ms)
  if (dd <= 0) return `hoje ${relogio(alvo)}`
  if (dd === 1) return `amanhã ${relogio(alvo)}`
  const d = local(alvo)
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${relogio(alvo)}`
}
function termino(p: Plano, ms: number): string {
  const [lo, hi] = restante(p, ms)
  return hi <= 0 ? '' : `fim ~${quando(ms + ((lo + hi) / 2) * 60_000, ms)}`
}

const semEstimativa = (p: Plano) =>
  p.tarefas.filter(t => !t.estimada && !t.tipo && t.estado !== 'feita' && t.estado !== 'pergunta').length
const resto = (p: Plano, ms: number) => {
  const [lo, hi] = restante(p, ms)
  const n = semEstimativa(p)
  const q = p.tarefas.filter(t => t.estado === 'pergunta').length
  return `${provavel(lo, hi)}${n > 0 ? ` + ${n} sem estimativa` : ''}${q > 0 ? ` + ${q} dependem de você` : ''}`
}

function textoPlano(p: Plano, ms: number, cal: { fator: number | null; n: number }): string {
  const [lo, hi] = restante(p, ms)
  const fim = termino(p, ms)
  const qs = linhasPerguntas(p, ms).map(textoLinha)
  const linhas = [
    `🎯 ${p.objetivo} — ⏱ resta ${resto(p, ms)}${fim ? ` · ${fim}` : ''}`,
    ...arvore(p, ms).map(textoLinha),
    ...(qs.length > 0 ? ['Perguntas para o usuário (fora da árvore até a resposta):', ...qs] : []),
  ]
  if (cal.fator != null) {
    linhas.push(
      `Calibração: suas tarefas levam ${cal.fator.toFixed(1)}× a estimativa média (n=${cal.n}); ` +
        `corrigido, resta ${faixa(lo * cal.fator, hi * cal.fator)}. Ajuste as próximas faixas por esse fator.`,
    )
  } else {
    linhas.push(`Calibração: ${cal.n}/${MIN_AMOSTRAS} tarefas medidas, ainda sem fator.`)
  }
  const paradas = p.tarefas.filter(t => parada(t, ms))
  if (paradas.length > 0) {
    linhas.push(`Paradas muito além do teto: ${paradas.map(t => t.titulo).join(' · ')}. Marque como feita ou reestime com ${TOOL_TAREFA}.`)
  }
  return linhas.join('\n')
}

// ── entrada das ferramentas ──────────────────────────────────────────────

const ESTADOS = Object.keys(ICONE) as Estado[]
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const estado = (v: unknown): Estado | null => (ESTADOS.includes(v as Estado) ? (v as Estado) : null)

// ── transições ───────────────────────────────────────────────────────────

// Aplica o novo estado guardando os horários reais: começa ao entrar em andamento, termina ao virar feita
function transita(t: Tarefa, est: Estado, ms: number): Tarefa {
  return {
    ...t,
    estado: est,
    inicio: t.inicio ?? (est === 'andamento' || est === 'feita' ? ms : null),
    fim: est === 'feita' ? (t.fim ?? ms) : null,
  }
}

// Lê o plano, aplica a mudança e grava; amostra de calibração para cada tarefa estimada que acabou de terminar
async function aplica($: EngineInterface, muda: (p: Plano, ms: number) => Plano): Promise<{ antes: Plano | null; depois: Plano; ms: number }> {
  const ms = await $.clock.now()
  const antes = await read($, plano)
  const depois = muda(antes ?? { objetivo: OBJETIVO_PADRAO, tarefas: [] }, ms)
  const eraFeita = new Set((antes?.tarefas ?? []).filter(t => t.estado === 'feita').map(t => t.id))
  const novas: Amostra[] = depois.tarefas
    .filter(t => t.estado === 'feita' && !eraFeita.has(t.id) && t.estimada && t.inicio != null && t.fim != null)
    .map(t => ({ estimado: (t.min + t.max) / 2, real: (t.fim! - t.inicio!) / 60_000 }))
    .filter(a => a.estimado > 0 && a.real > 0.5)
  if (novas.length > 0) {
    const hist = ((await $.store.get('historico')) ?? []) as Amostra[]
    await $.store.set('historico', [...hist, ...novas].slice(-HISTORICO_MAX))
  }
  await update($, plano, () => depois)
  await update($, agora, () => ms)
  return { antes, depois, ms }
}

const DE_TODO: Record<string, Estado> = { pending: 'proxima', in_progress: 'andamento', completed: 'feita' }
const espelhada = (t: Tarefa) => t.id.startsWith('todo:') || t.id.startsWith('task:') || t.tipo != null
const nova = (id: string, titulo: string, ref: string | null = null): Tarefa => ({
  id, titulo, pai: null, min: 0, max: 0, estado: 'proxima', esperando: null, estimada: false, ref, inicio: null, fim: null,
})

// Entra como filha da única tarefa em andamento do plano (é trabalho para ela); com zero ou várias, na raiz
function entraParalela(p: Plano, x: Pick<Tarefa, 'id' | 'titulo' | 'tipo' | 'ref' | 'inicio' | 'fim'>): Plano {
  if (p.tarefas.some(t => t.id === x.id)) return p
  const rodando = p.tarefas.filter(t => t.estado === 'andamento' && !t.tipo)
  const t: Tarefa = {
    ...nova(x.id, x.titulo, x.ref), ...x, pai: rodando.length === 1 ? rodando[0]!.id : null,
    estado: x.fim != null ? 'feita' : 'andamento',
  }
  return { ...p, tarefas: [...p.tarefas, t] }
}

// Fecha um subagente ou processo: feita, ou bloqueada com o motivo quando falhou ou foi interrompido
async function encerra($: EngineInterface, achar: (t: Tarefa) => boolean, status: string | undefined, duracao?: number) {
  const p = await read($, plano)
  if (!p?.tarefas.some(t => t.tipo && t.estado === 'andamento' && achar(t))) return
  const falhou = status === 'failed' ? 'falhou' : status === 'killed' ? 'interrompido' : null
  await aplica($, (atual, ms) => ({
    ...atual,
    tarefas: atual.tarefas.map(t => {
      if (!t.tipo || t.estado !== 'andamento' || !achar(t)) return t
      const fim = duracao != null && t.inicio != null ? Math.max(t.inicio, Math.min(ms, t.inicio + duracao)) : ms
      return { ...t, estado: falhou ? 'bloqueada' : 'feita', esperando: falhou, fim }
    }),
  }))
}

async function confereAgentes($: EngineInterface) {
  const p = await read($, plano)
  if (!p?.tarefas.some(t => t.tipo === 'agente' && t.estado === 'andamento')) return
  for (const a of await $.agent.list()) {
    if (a.status === 'completed' || a.status === 'failed' || a.status === 'killed') {
      await encerra($, t => t.id === `agente:${a.id}`, a.status)
    }
  }
}

type Aviso = { id?: string; status?: string; toolUseId?: string; durationMs?: number }

export const register: Register = on => {
  const avisadas = new Set<string>()
  // Avisos de término vistos ao desenhar a conversa: gravar ali é recusado, então o timer de 2 s aplica depois
  const avisos: Aviso[] = []

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'plano',
      isDeferred: false,
      description:
        'Registra o plano do trabalho como árvore de tarefas com ETA, mostrado ao usuário numa faixa acima do prompt ' +
        'com o relógio real. Use antes de começar qualquer pedido com 2 ou mais etapas, e de novo quando o plano mudar ' +
        '(substitui o anterior, mantendo os tempos das tarefas de mesmo id). pai = id da tarefa de que esta depende ' +
        '(só começa quando o pai termina); sem pai = independente. min/max = faixa em minutos de relógio. ' +
        'estado "pergunta" = espera uma resposta do usuário (escreva a pergunta em esperando); "esperando" = espera ' +
        'algo de fora. Respondida a pergunta, mude o estado com mcp__eta__tarefa. ' +
        'A resposta traz o fator de calibração do seu histórico: aplique-o às faixas.',
      inputSchema: {
        type: 'object',
        required: ['objetivo', 'tarefas'],
        properties: {
          objetivo: { type: 'string', description: 'O pedido do usuário, em uma linha' },
          tarefas: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'titulo', 'min', 'max'],
              properties: {
                id: { type: 'string' },
                titulo: { type: 'string' },
                pai: { type: 'string' },
                min: { type: 'number' },
                max: { type: 'number' },
                estado: { type: 'string', enum: ESTADOS },
                esperando: { type: 'string', description: 'estado = esperando: o que ou quem a tarefa espera; estado = pergunta: a pergunta ao usuário' },
              },
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'tarefa',
      isDeferred: false,
      description:
        'Atualiza uma tarefa do plano registrado com mcp__eta__plano. Chame com estado "andamento" ao começar cada ' +
        'tarefa e "feita" ao terminar: o relógio real e a calibração dependem dessas duas chamadas.',
      inputSchema: {
        type: 'object',
        required: ['id', 'estado'],
        properties: {
          id: { type: 'string' },
          estado: { type: 'string', enum: ESTADOS },
          esperando: { type: 'string', description: 'O que a tarefa espera, ou a pergunta ao usuário quando estado = pergunta' },
          min: { type: 'number', description: 'Nova faixa, ao reestimar' },
          max: { type: 'number' },
        },
      },
    })

    // O comando é um extra: se falhar, as ferramentas e o relógio seguem
    try {
      await $.command.register({ name: 'eta', description: 'Abre ou fecha a faixa do ETA' })
    } catch {}

    try {
      const tz = await $.process.run(['date', '+%z'])
      const m = /^([+-])(\d{2})(\d{2})$/.exec(tz.stdout.trim())
      if (m) offsetMin = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
    } catch {}

    $.clock.every(2_000, () => {
      if (avisos.length === 0) return
      const lote = avisos.splice(0)
      void (async () => {
        for (const task of lote) {
          try {
            await encerra(
              $,
              t => (task.toolUseId != null && t.ref === task.toolUseId) || (task.id != null && t.id.endsWith(`:${task.id}`)),
              task.status,
              task.durationMs,
            )
          } catch {}
        }
      })()
    })

    const inicio = await $.clock.now()
    await update($, agora, () => inicio)
    $.clock.every(TICK_MS, () => {
      void (async () => {
        const ms = await $.clock.now()
        await update($, agora, () => ms)
        try {
          await confereAgentes($)
        } catch {}
        const p = await read($, plano)
        for (const t of p?.tarefas ?? []) {
          if (atrasada(t, ms) && !avisadas.has(t.id)) {
            avisadas.add(t.id)
            $.ui.toast(`⚠️ ${t.titulo} passou de ${faixa(t.min, t.max)}`)
          }
        }
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'eta' }, async $ => {
    await update($, aberta, v => !v)
    return { text: (await read($, aberta)) ? 'ETA: faixa aberta.' : 'ETA: faixa fechada.' }
  })

  on('tool.call', { tool: TOOL_PLANO }, async ($, e) => {
    try {
      const objetivo = str(e.objetivo)
      const brutas = Array.isArray(e.tarefas) ? (e.tarefas as Record<string, unknown>[]) : null
      if (!objetivo || !brutas || brutas.length === 0) return { deny: 'Informe objetivo e ao menos uma tarefa.' }

      const ms = await $.clock.now()
      const anteriores = (await read($, plano))?.tarefas ?? []
      const antes = new Map(anteriores.map(t => [t.id, t]))
      const porTitulo = new Map(anteriores.map(t => [t.titulo, t]))
      const usadas = new Set<string>()
      const tarefas: Tarefa[] = []
      for (const b of brutas) {
        const id = str(b.id)
        const titulo = str(b.titulo)
        const min = num(b.min)
        const max = num(b.max)
        if (!id || !titulo || min == null || max == null) return { deny: `Tarefa inválida: ${JSON.stringify(b)}` }
        // Mesmo id, ou a tarefa espelhada de mesmo título: herda horários e ref
        const velha = antes.get(id) ?? porTitulo.get(titulo)
        if (velha) usadas.add(velha.id)
        const est = estado(b.estado) ?? velha?.estado ?? 'proxima'
        const base: Tarefa = {
          id, titulo, pai: str(b.pai), min: Math.min(min, max), max: Math.max(min, max), estado: velha?.estado ?? est,
          esperando: str(b.esperando), estimada: true, ref: velha?.ref ?? null,
          inicio: velha?.inicio ?? null, fim: velha?.fim ?? null,
        }
        tarefas.push(transita(base, est, ms))
      }
      // Espelhadas que o plano não citou continuam, até o TodoWrite/TaskUpdate tirá-las
      const restantes = anteriores.filter(t => espelhada(t) && !usadas.has(t.id))
      const { depois } = await aplica($, () => ({ objetivo, tarefas: [...tarefas, ...restantes] }))

      return { result: textoPlano(depois, ms, await fator($)) }
    } catch (err) {
      return { deny: `eta: ${String(err)}` }
    }
  })

  on('tool.call', { tool: TOOL_TAREFA }, async ($, e) => {
    try {
      const p = await read($, plano)
      const id = str(e.id)
      const est = estado(e.estado)
      const alvo = p?.tarefas.find(t => t.id === id)
      if (!p || !alvo || !est) return { deny: 'Plano ou tarefa não encontrados: registre com mcp__eta__plano.' }

      const min = num(e.min)
      const max = num(e.max)
      if (min != null && max != null) avisadas.delete(alvo.id)
      const { depois, ms } = await aplica($, (atual, ms) => ({
        ...atual,
        tarefas: atual.tarefas.map(x => {
          if (x.id !== alvo.id) return x
          const t: Tarefa = { ...x, esperando: str(e.esperando) ?? x.esperando }
          if (min != null && max != null) Object.assign(t, { min: Math.min(min, max), max: Math.max(min, max), estimada: true })
          return transita(t, est, ms)
        }),
      }))
      const t = depois.tarefas.find(x => x.id === alvo.id)!
      const nota = est === 'feita' && t.inicio != null ? ` — levou ${levou(t, ms)} (estimado ${faixaDe(t)})` : ''

      return { result: `${ICONE[est]} ${t.titulo}${nota}` }
    } catch (err) {
      return { deny: `eta: ${String(err)}` }
    }
  })

  // ── espelho das listas de tarefas do próprio Claude Code ─────────────────
  // O espelho nunca atrapalha a ferramenta: qualquer erro aqui é engolido e o resultado original volta

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if ('deny' in r || r.isError) return r
      const todos = (e as { todos?: { content?: unknown; status?: unknown }[] }).todos ?? []
      await aplica($, (atual, ms) => {
        const porTitulo = new Map(atual.tarefas.map(t => [t.titulo, t]))
        const vistas = new Set<string>()
        const tarefas = [...atual.tarefas]
        for (const td of todos) {
          const titulo = str(td.content)
          const est = DE_TODO[String(td.status)]
          if (!titulo || !est) continue
          const velha = porTitulo.get(titulo)
          if (velha) {
            vistas.add(velha.id)
            tarefas[tarefas.indexOf(velha)] = transita(velha, est, ms)
          } else {
            const t = transita(nova(`todo:${titulo}`, titulo), est, ms)
            vistas.add(t.id)
            tarefas.push(t)
          }
        }
        // TodoWrite manda a lista inteira: o que veio dele e sumiu da lista sai da árvore
        return { ...atual, tarefas: tarefas.filter(t => !t.id.startsWith('todo:') || vistas.has(t.id)) }
      })
    } catch {}
    return r
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if ('deny' in r || r.isError) return r
      const criada = (r.result as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task
      const ref = str(criada?.id)
      const titulo = str(criada?.subject) ?? str((e as { subject?: unknown }).subject)
      if (!ref || !titulo) return r
      await aplica($, atual => {
        const velha = atual.tarefas.find(t => t.titulo === titulo && t.ref == null)
        return {
          ...atual,
          tarefas: velha
            ? atual.tarefas.map(t => (t === velha ? { ...t, ref } : t))
            : [...atual.tarefas, nova(`task:${ref}`, titulo, ref)],
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
      await aplica($, (atual, ms) => {
        if (u.status === 'deleted') return { ...atual, tarefas: atual.tarefas.filter(t => t.ref !== ref) }
        const bloqueio = Array.isArray(u.addBlockedBy) ? str(u.addBlockedBy[0]) : null
        const pai = bloqueio ? (atual.tarefas.find(t => t.ref === bloqueio)?.id ?? null) : null
        return {
          ...atual,
          tarefas: atual.tarefas.map(t => {
            if (t.ref !== ref) return t
            let x: Tarefa = { ...t, titulo: str(u.subject) ?? t.titulo, pai: pai ?? t.pai }
            const est = DE_TODO[String(u.status)]
            if (est) x = transita(x, est, ms)
            return x
          }),
        }
      })
    } catch {}
    return r
  })

  // ── subagentes e processos em segundo plano ───────────────────────────────

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if ('deny' in r || r.isError) return r
      const res = r.result as { agentId?: unknown; totalDurationMs?: unknown } | undefined
      const id = str(res?.agentId)
      if (!id) return r
      const a = e as { description?: unknown; subagent_type?: unknown }
      // Em primeiro plano a chamada só volta com o agente pronto, já trazendo a duração
      const duracao = typeof res?.totalDurationMs === 'number' ? res.totalDurationMs : null
      const ms = await $.clock.now()
      await aplica($, atual =>
        entraParalela(atual, {
          id: `agente:${id}`, titulo: `${str(a.subagent_type) ?? 'agente'}: ${str(a.description) ?? 'subagente'}`,
          tipo: 'agente', ref: e.tool_use_id, inicio: duracao != null ? ms - duracao : ms, fim: duracao != null ? ms : null,
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
      await aplica($, atual =>
        entraParalela(atual, {
          id: `processo:${id}`, titulo: str(b.description) ?? corta(str(b.command) ?? 'processo', 60),
          tipo: 'processo', ref: e.tool_use_id, inicio: ms, fim: null,
        }),
      )
    } catch {}
    return r
  })

  // Um subagente terminou um turno: confere na lista se acabou de vez
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if ((e as { agentId?: string }).agentId) {
      try {
        await confereAgentes($)
      } catch {}
    }
    return r
  })

  // O aviso de término de uma tarefa em segundo plano chega como mensagem na conversa: fecha a tarefa dele
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const task = (e.props as { task?: Aviso }).task
    if (task && (task.id || task.toolUseId)) avisos.push({ ...task })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, plano)
    if (e.props.hasSurvey || !p || p.tarefas.every(t => t.estado === 'feita') || !(await read($, aberta))) return next(e)

    // `agora` só serve para redesenhar a cada tique; o tempo vem do relógio, senão fica até 1 tique atrasado
    await read($, agora)
    const ms = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const largura = Number.isFinite(e.props.bodyColumns) ? Math.max(30, Math.floor(e.props.bodyColumns)) : 100
    const feitas = p.tarefas.filter(t => t.estado === 'feita').length
    const esperando = p.tarefas.filter(t => t.estado === 'esperando')
    const linhas = arvore(p, ms)
    const qs = linhasPerguntas(p, ms)

    const fim = termino(p, ms)
    const info = ` ✓ ${feitas}/${p.tarefas.length} · ◷ resta ${resto(p, ms)}${fim ? ` · ✓ ${fim}` : ''}`
    const desenha = (l: Linha) => {
      const st = textoStatus(l)
      const sobra = largura - 1 - l.prefixo.length - 2 - (st ? st.length + 3 : 0)
      return (
        <Text dimColor={l.apagada}>
          <Text dimColor>{l.prefixo}</Text>
          <Text color={l.icone.cor} dimColor={l.icone.apagado} bold={l.icone.negrito}>{l.icone.texto}</Text>
          {` ${corta(l.titulo, Math.max(12, sobra))}`}
          {st ? ' — ' : ''}
          {l.status.map(s => (
            <Text color={s.cor} dimColor={s.apagado}>{s.texto}</Text>
          ))}
        </Text>
      )
    }
    const espera = esperando.map(t => `${t.titulo}${t.esperando ? ` (${t.esperando})` : ''}`).join(' · ')

    return (
      <Box flexDirection="column">
        {/* Régua de largura cheia: separa a faixa da conversa acima */}
        <Text dimColor>{'─'.repeat(largura)}</Text>
        <Text>
          <Text bold>⏱ {corta(p.objetivo, Math.max(10, largura - info.length - 6))}</Text>
          <Text dimColor>{info}</Text>
        </Text>
        <Text> </Text>
        {esperando.length > 0 ? (
          <Text color="permission">{corta(`${ICONE.esperando} ${esperando.length} esperando: ${espera}`, largura - 1)}</Text>
        ) : null}
        {linhas.map(desenha)}
        {qs.length > 0 ? <Text> </Text> : null}
        {qs.map(desenha)}
      </Box>
    )
  })
}
