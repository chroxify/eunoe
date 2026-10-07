import type { Config } from "../config/types"
import type { Body, Message } from "../context/types"
import type { TranscriptRef } from "../transcript/types"

export interface ThreadState {
  cut?: string
  keep?: number
  cleared?: number
  ratio?: number
}

export type Note = Record<string, unknown>

export interface ContextFingerprint {
  system: string
  tools: string
  skills: string[]
}

export interface RewriteInput {
  body: Body
  sessionId: string | null
  config: Config
  transcript: TranscriptRef | null
  window: number | null
  mayCompact: boolean
  omittedBefore?: number
}

export interface Rewrite {
  body: Body
  threadKey: string | null
  note: Note
}

export interface CompactInput {
  body: Body
  config: Config
  state: ThreadState
  window: number | null
  guide: string | null
  mayCompact: boolean
  omittedBefore?: number
}

export interface CompactResult {
  messages: Message[]
  stateChanged: boolean
  note: Note
}

export interface Estimator {
  of: (messages: Message[]) => number
  fixed: number
}

export type Usage = Record<string, number>

export interface SeenSession {
  lastSeen: string
  mode: Config["mode"]
  cwd?: string
}

export interface Health {
  ok: boolean
  version: string
  mode: Config["mode"]
  pid: number
}
