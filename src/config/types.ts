export type Mode = "off" | "trim" | "compact"
export type SearchMode = "jsonl" | "markdown" | "xml" | "qmd"

export interface EvalConfig {
  strategy?: "tail" | "guide"
  tailTurns?: number
  forceCut?: boolean
  trustHeaders?: boolean
}

export interface Config {
  mode: Mode
  port: number
  compactAt: number
  keepTurns: number | "all"
  search: SearchMode
  upstream: string
  claudeConfigDirs: string[]
  window?: number
  eval?: EvalConfig
}
