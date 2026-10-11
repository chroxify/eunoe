import type { Config } from "../../config/types"

export interface ReplayOptions {
  config: Config
  window: number
  fixedTokens: number
  recallChars?: number
}

export interface Replay {
  requests: number
  turns: number
  folds: number
  nativeCompactions: number
  discarded: number
  plainTokens: number
  eunoeTokens: number
  plainCost: number
  eunoeCost: number
  peakPlain: number
  peakEunoe: number
}

export interface ReplayedSession extends Replay {
  id: string
  file: string
  bytes: number
  cwd: string | null
  title: string | null
  ms: number
}
