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

export interface CompactOptions {
  keepTurns: number
  guide: string | null
  omittedBefore?: number
}

export interface NoticeCounts {
  omitted: number
  kept: number
  guide: string | null
}
