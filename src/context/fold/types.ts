import type { Message } from "../types"

export interface ReduceOptions {
  evidence?: boolean
}

export interface CompactOptions extends ReduceOptions {
  keepTurns: number
  capChars?: number
  guide: string | null
  omittedBefore?: number
  reduce?: (turn: Message[], options: ReduceOptions) => Message[]
}

export interface EvidenceOptions {
  linesPerCall?: number
  lineChars?: number
  turnChars?: number
  scanLines?: number
  minScore?: number
  allTools?: boolean
  ranked?: boolean
  labels?: boolean
  callFloor?: number
}

export interface FoldedTurn {
  user: string
  evidence: string
  reply: string
}
