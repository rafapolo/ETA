import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000

const BAND = {
  plugin: 'eta',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

type On = Parameters<Parameters<typeof test>[1]>[1]

// 1000 min após a época = 16:40 UTC; com -0300, 13:40 local
function fuso(on: On) {
  on('process.run', () => ({ value: { exitCode: 0, stdout: '-0300\n', stderr: '', isStdoutTruncated: false } }))
}

async function inicia($: Parameters<Parameters<typeof test>[1]>[0], on: On) {
  mock.clock(on, { now: 1_000 * MIN })
  mock.store(on)
  fuso(on)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__eta__${(e as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

const PLANO = {
  tool: 'mcp__eta__plano',
  objetivo: 'Atualizar o site',
  tarefas: [
    { id: 'dados', titulo: 'Regerar JSON', min: 5, max: 10 },
    { id: 'readme', titulo: 'README', pai: 'dados', min: 5, max: 10 },
    { id: 'commit', titulo: 'Commit', pai: 'readme', min: 2, max: 5 },
  ],
} as const

test('plano em árvore, relógio real e calibração', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 * MIN })
  mock.store(on, { historico: Array.from({ length: 5 }, () => ({ estimado: 5, real: 10 })) })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__eta__${(e as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  fuso(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? JSON.stringify(e)))
    return { value: {} }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const plano = await $.tool.call(PLANO)
  const texto = String((plano as { result?: unknown }).result)
  expect(texto).toContain('🎯 Atualizar o site — ⏱ resta 12–25 min · fim ~hoje 13:58')
  // Cada dependência recua sob o ícone da mãe
  expect(texto).toContain('\n○ Regerar JSON — 5–10 min\n└ ○ README — 5–10 min\n  └ ○ Commit — 2–5 min\n')
  expect(texto).toContain('2.0×')

  await $.tool.call({ tool: 'mcp__eta__tarefa', id: 'dados', estado: 'andamento' })
  await clock.advance(12 * MIN)
  expect(toasts.join(' ')).toContain('Regerar JSON passou de 5–10 min')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Regerar JSON/ }))?.text).toBe('! Regerar JSON — +2 min além')
  await ui.unmount()

  const feita = await $.tool.call({ tool: 'mcp__eta__tarefa', id: 'dados', estado: 'feita' })
  expect(String((feita as { result?: unknown }).result)).toBe('✓ Regerar JSON — levou 12 min (estimado 5–10 min)')
  const replano = await $.tool.call(PLANO)
  expect(String((replano as { result?: unknown }).result)).toContain('n=6')
  expect(String((replano as { result?: unknown }).result)).toContain('✓ Regerar JSON — levou 12 min')
})

test('sem plano a faixa fica com o engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('TodoWrite vira árvore sozinho e casa com o plano pelo título', async ($, on) => {
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  await inicia($, on)

  await $.tool.call(PLANO)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Regerar JSON', status: 'in_progress', activeForm: 'Regerando' },
      { content: 'Rodar testes', status: 'pending', activeForm: 'Testando' },
    ],
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /resta/ }))?.text).toContain('resta 12–25 min + 1 sem estimativa')
  expect((await ui.find({ type: 'Text', text: /Regerar JSON/ }))?.text).toBe('▶ Regerar JSON — ────────  0% · faltam 5–10 min')
  await ui.unmount()

  // Lista inteira de novo: 'Rodar testes' some, a tarefa do plano fica
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Regerar JSON', status: 'completed', activeForm: 'x' }] })
  const texto = String(((await $.tool.call(PLANO)) as { result?: unknown }).result)
  expect(texto).toContain('✓ Regerar JSON')
  expect(texto).not.toContain('Rodar testes')
})

test('TaskCreate e TaskUpdate entram na árvore com dependência', async ($, on) => {
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, (_, e) => ({
    result: { task: { id: String(++n), subject: (e as { subject: string }).subject } },
  }))
  on('tool.call', { tool: 'TaskUpdate' }, (_, e) => ({
    result: { success: true, taskId: (e as { taskId: string }).taskId, updatedFields: [] },
  }))
  await inicia($, on)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Baixar dados', description: 'x' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Gerar gráfico', description: 'y' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', addBlockedBy: ['1'] })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Baixar dados/ }))?.text).toBe('▶ Baixar dados — 0 min')
  expect((await ui.find({ type: 'Text', text: /Gerar gráfico/ }))?.text).toBe('└ ○ Gerar gráfico — ?')
  await ui.unmount()

  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'deleted' })
  const ui2 = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui2.find({ type: 'Text', text: /Gerar gráfico/ })).toBeUndefined()
  await ui2.unmount()
})

test('progresso compacto: meio da faixa, horas e estouro', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 * MIN })
  mock.store(on)
  fuso(on)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__eta__${(e as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({
    tool: 'mcp__eta__plano',
    objetivo: 'x',
    tarefas: [
      { id: 'a', titulo: 'Curta', min: 5, max: 10, estado: 'andamento' },
      { id: 'b', titulo: 'Longa', min: 2400, max: 3600, estado: 'andamento' },
    ],
  })
  await clock.advance(7 * MIN)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Curta/ }))?.text).toBe('▶ Curta — ━━━━━━━─  93% · até 3 min')
  await ui.unmount()

  await clock.advance(68 * MIN)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Longa/ }))?.text).toBe('▶ Longa — ────────  2% · faltam ~49 h (39–59)')
  expect((await ui.find({ type: 'Text', text: /Curta/ }))?.text).toBe('! Curta — parada? +1:05 h além')
  await ui.unmount()
})

test('tarefa que começou depois do último tique não quebra a faixa', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 * MIN })
  mock.store(on)
  fuso(on)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__eta__${(e as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({
    tool: 'mcp__eta__plano',
    objetivo: 'x',
    tarefas: [
      { id: 'f', titulo: 'feitas', min: 0, max: 0, estado: 'feita' },
      { id: 'l', titulo: 'Longa', min: 900, max: 2400 },
    ],
  })
  await clock.advance(30_000)
  await $.tool.call({ tool: 'mcp__eta__tarefa', id: 'l', estado: 'andamento' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Longa/ }))?.text).toBe('▶ Longa — ────────  0% · faltam ~28 h (15–40)')
  await ui.unmount()
})

test('árvore sempre completa e /eta abre e fecha a faixa', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 * MIN })
  mock.store(on)
  fuso(on)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__eta__${(e as { name: string }).name}` } }))
  on('command.register', () => ({ value: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // O engine desenha a faixa vazia quando o mod a deixa passar
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({
    tool: 'mcp__eta__plano',
    objetivo: 'Migrar o banco, reprocessar os arquivos antigos e publicar a v2 com um título bem comprido',
    tarefas: [
      { id: 'staging', titulo: 'Dados em staging', min: 5, max: 10, estado: 'feita' },
      { id: 'reproc', titulo: 'reprocessa_2025', pai: 'staging', min: 60, max: 120, estado: 'andamento' },
      { id: 'anexa', titulo: 'anexa', pai: 'reproc', min: 30, max: 90 },
      { id: 'views', titulo: 'views', pai: 'anexa', min: 20, max: 40 },
      { id: 'importa', titulo: 'Importar dados', min: 240, max: 1440, estado: 'andamento' },
      { id: 'ok', titulo: 'formato do relatório', min: 60, max: 120, estado: 'esperando', esperando: 'seu ok' },
    ],
  })
  await clock.advance(10 * MIN)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const cab = (await ui.find({ type: 'Text', text: /resta/ }))?.text ?? ''
  // As duas em andamento correm juntas (vale Importar, 230–1430); a fila soma em série (anexa, views, plano: 110–250)
  expect(cab).toContain('✓ 1/6 · ◷ resta ~17 h (6–28) · ✓ fim ~amanhã 06:40')
  expect(cab).not.toContain('/eta')
  expect(cab.startsWith('⏱ Migrar o banco')).toBe(true)
  expect(cab).toContain('…')
  expect(cab.length).toBeLessThanOrEqual(100)
  expect((await ui.find({ type: 'Text', text: /esperando:/ }))?.text).toBe('◷ 1 esperando: formato do relatório (seu ok)')
  // Feitas ficam e a fila inteira aparece, sem conta de "+N depois"
  expect((await ui.find({ type: 'Text', text: /Dados em staging/ }))?.text).toBe('✓ Dados em staging')
  expect((await ui.find({ type: 'Text', text: /reprocessa_2025/ }))?.text).toBe('└ ▶ reprocessa_2025 — ────────  11% · faltam ~1:20 h (0:50–1:50)')
  expect((await ui.find({ type: 'Text', text: /anexa/ }))?.text).toBe('  └ ○ anexa — 0:30–1:30 h')
  expect((await ui.find({ type: 'Text', text: /views/ }))?.text).toBe('    └ ○ views — 20–40 min')
  await ui.unmount()

  expect((await $.command.run({ command: 'eta', args: '' }) as { text?: string }).text).toBe('ETA: faixa fechada.')
  const fechada = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await fechada.find({ type: 'Text', text: /resta/ })).toBeUndefined()
  expect((await fechada.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await fechada.unmount()

  expect((await $.command.run({ command: 'eta', args: '' }) as { text?: string }).text).toBe('ETA: faixa aberta.')
  const de_novo = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await de_novo.find({ type: 'Text', text: /views/ }))?.text).toBe('    └ ○ views — 20–40 min')
  await de_novo.unmount()
})

test('perguntas ficam abaixo da árvore e voltam para ela ao serem respondidas', async ($, on) => {
  await inicia($, on)
  await $.tool.call({
    tool: 'mcp__eta__plano',
    objetivo: 'x',
    tarefas: [
      { id: 'a', titulo: 'Importar', min: 60, max: 120, estado: 'andamento' },
      { id: 'q', titulo: 'Formato do relatório', pai: 'a', min: 60, max: 120, estado: 'pergunta', esperando: 'Opção A ou B?' },
      { id: 'q2', titulo: 'Gerar relatório', pai: 'q', min: 10, max: 20 },
    ],
  })
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /resta/ }))?.text).toContain('resta ~1:45 h (1:10–2:20) + 1 dependem de você')
  expect((await ui.find({ type: 'Text', text: /Formato do relatório/ }))?.text).toBe('? Formato do relatório — Opção A ou B? · depois 1–2 h · +1 depois')
  expect(await ui.find({ type: 'Text', text: /Gerar relatório/ })).toBeUndefined()
  await ui.unmount()

  await $.tool.call({ tool: 'mcp__eta__tarefa', id: 'q', estado: 'proxima' })
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Formato do relatório/ }))?.text).toBe('└ ○ Formato do relatório — 1–2 h')
  expect((await ui.find({ type: 'Text', text: /Gerar relatório/ }))?.text).toBe('  └ ○ Gerar relatório — 10–20 min')
  await ui.unmount()
})
