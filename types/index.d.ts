export type Status = 'next' | 'running' | 'done' | 'waiting' | 'blocked' | 'question'

export type Task = {
  id: string
  title: string
  parent: string | null
  min: number
  max: number
  status: Status
  /** status = waiting: what or who the task waits on; status = question: the question to the user */
  waitingOn: string | null
  /** false = mirrored from TodoWrite/TaskCreate, or a subagent or process, with no time range */
  estimated: boolean
  /** The id in TaskCreate/TaskUpdate, or the tool_use_id that started a subagent or process */
  ref: string | null
  start: number | null
  end: number | null
  /** A subagent (Agent) or a background process (Bash), mirrored on its own */
  kind?: 'agent' | 'process'
}

export type Plan = { goal: string; tasks: Task[] }

/** The plan as versions before the English rewrite stored it, read once to migrate */
export type LegacyTask = {
  id: string
  titulo: string
  pai: string | null
  min: number
  max: number
  estado: string
  esperando: string | null
  estimada: boolean
  ref: string | null
  inicio: number | null
  fim: number | null
  tipo?: string
}
export type LegacyPlan = { objetivo: string; tarefas: LegacyTask[] }

declare module 'claude-code' {
  interface PluginState {
    eta: { plan: Shaped<Plan | null>; now: number; open: boolean; plano: Shaped<LegacyPlan | null> }
  }
}
