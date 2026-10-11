export type Mode = "off" | "compact" | "default"
export type SearchMode = "jsonl" | "markdown" | "xml" | "qmd"
export type Scope = "all" | "sessions"

interface RollingConfig {
  keep: number
  budget: number
}

interface RerankConfig {
  model: string
  candidates?: number
  endpoint?: string
}

interface EvalConfig {
  recallOptions?: { maxChars?: number; maxCharsMulti?: number; perQuery?: number }
  strategy?: "tail" | "guide" | "trim"
  rolling?: RollingConfig
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
  turnCap: number | "off"
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
