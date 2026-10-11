export interface Settings {
  env?: Record<string, string>
  autoCompactEnabled?: boolean
  [key: string]: unknown
}

export interface Agent {
  label: string
  plist: string
  keepAlive?: boolean
  interval?: number
}

export interface Watch {
  misses: number
  paused: string[]
  pausedAt?: string
}

export interface RequestRecord {
  ts: string
  action?: string
  thread?: string | null
  input?: number
  charsIn?: number
  charsOut?: number
  charsFixed?: number
  cacheRead?: number
  cacheWrite?: number
  uncached?: number
  compacted?: boolean
  turns?: number
  reranked?: string
  rerankError?: string
  overflow?: number
  fit?: string
  [key: string]: unknown
}

export interface SessionStats {
  context: number
  fixed: number | null
  plain: number | null
  turns: number | null
  requests: number
  folds: number
  lastSeen: string
}

export interface Totals {
  requests: number
  cacheRead: number
  cacheWrite: number
  uncached: number
  folds: number
  lastFold: string | null
  sent: number
  saved: number
}
