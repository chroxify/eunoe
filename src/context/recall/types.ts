export interface RecallChunk {
  turn: number
  from?: string
  call: string
  lines: string[]
  terms: string[]
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
