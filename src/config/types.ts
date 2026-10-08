export type Mode = "off" | "compact" | "default"
export type SearchMode = "jsonl" | "markdown" | "xml" | "qmd"
export type Scope = "all" | "sessions"

export interface RollingConfig {
  keep: number
  budget: number
}

export interface RerankConfig {
  model: string
  candidates?: number
}

export interface EvalConfig {
  strategy?: "tail" | "guide" | "trim"
  rolling?: RollingConfig
  tailTurns?: number
  forceCut?: boolean
  trustHeaders?: boolean
  evidence?: boolean
  recall?: boolean
  rerank?: RerankConfig
}

export interface Tunables {
  compactAt: number
  keepTurns: number | "all"
  keep: number
  budget: number
  search: SearchMode
  rerank: string
}

export type Tunable = keyof Tunables

export interface SessionSettings extends Partial<Tunables> {
  mode?: Mode
}

export interface Config extends Tunables {
  mode: Mode
  scope: Scope
  sessions: Record<string, SessionSettings>
  port: number
  upstream: string
  claudeConfigDirs: string[]
  window?: number
  eval?: EvalConfig
}
