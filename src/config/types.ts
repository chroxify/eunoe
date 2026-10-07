export type Mode = "off" | "trim" | "compact"
export type SearchMode = "jsonl" | "markdown" | "xml" | "qmd"
export type Scope = "all" | "sessions"

export interface RollingConfig {
  keep: number
  budget: number
}

export interface EvalConfig {
  strategy?: "tail" | "guide"
  rolling?: RollingConfig
  tailTurns?: number
  forceCut?: boolean
  trustHeaders?: boolean
}

export interface Tunables {
  compactAt: number
  keepTurns: number | "all"
  search: SearchMode
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
