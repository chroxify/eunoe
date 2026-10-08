export type Block = { type: string; [key: string]: any }

export type Message = { role: string; content: string | Block[] }

export type Body = {
  model?: string
  system?: string | Block[]
  messages: Message[]
  tools?: unknown[]
  metadata?: { user_id?: string }
  [key: string]: any
}

export interface ReduceOptions {
  evidence?: boolean
}

export interface CompactOptions extends ReduceOptions {
  keepTurns: number
  guide: string | null
  omittedBefore?: number
}

export interface NoticeCounts {
  omitted: number
  kept: number
  guide: string | null
}

export interface RecallChunk {
  turn: number
  call: string
  lines: string[]
  terms: string[]
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

export interface RecallOptions {
  windowLines?: number
  perQuery?: number
  minTerms?: number
  maxChars?: number
  maxCharsMulti?: number
  narrative?: boolean
  callWeight?: number
  salientExcerpt?: boolean
  candidates?: number
}

export type Reranker = (query: string, chunks: RecallChunk[], candidates: number[]) => Promise<number[]>

export interface RecallPick {
  index: number
  query: Set<string>
}
