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

export interface Config {
  mode: Mode
  scope: Scope
  sessions: Record<string, Mode | null>
  port: number
  compactAt: number
  keepTurns: number | "all"
  search: SearchMode
  upstream: string
  claudeConfigDirs: string[]
  window?: number
  eval?: EvalConfig
}
