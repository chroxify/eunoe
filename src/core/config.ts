export type Mode = "off" | "compact" | "default"

interface EvalConfig {
  recallOptions?: { maxChars?: number; maxCharsMulti?: number; maxCharsTotal?: number; perQuery?: number }
  strategy?: "tail" | "guide" | "trim"
  rolling?: { keep: number; budget: number }
  forceCut?: boolean
  trustHeaders?: boolean
  evidence?: boolean
  recall?: boolean
  rerank?: { model: string; candidates?: number; endpoint?: string }
}

export interface CoreConfig {
  mode: Mode
  compactAt: number
  keepTurns: number | "all"
  keep: number
  budget: number
  turnCap: number | "off"
  eval?: EvalConfig
}

export const CORE_DEFAULTS: CoreConfig = {
  mode: "default",
  compactAt: 0.9,
  keepTurns: "all",
  keep: 3,
  budget: 100_000,
  turnCap: 100_000,
}
