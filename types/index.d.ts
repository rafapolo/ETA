export type Estado = 'proxima' | 'andamento' | 'feita' | 'esperando' | 'bloqueada' | 'pergunta'

export type Tarefa = {
  id: string
  titulo: string
  pai: string | null
  min: number
  max: number
  estado: Estado
  esperando: string | null
  /** false = veio de TodoWrite/TaskCreate sem faixa de tempo */
  estimada: boolean
  /** id da tarefa no TaskCreate/TaskUpdate do Claude Code */
  ref: string | null
  inicio: number | null
  fim: number | null
  /** Subagente (Agent) ou processo em segundo plano (Bash), espelhados sozinhos */
  tipo?: 'agente' | 'processo'
}

export type Plano = { objetivo: string; tarefas: Tarefa[] }

declare module 'claude-code' {
  interface PluginState {
    eta: { plano: Shaped<Plano | null>; agora: number; aberta: boolean }
  }
}
