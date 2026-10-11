import type { Config } from "../config/types"
import type { CompactOptions } from "../context/fold/types"
import type { Body, Message } from "../context/types"
import type { TranscriptRef } from "../transcript/types"

export interface Handoff {
  label: string
  source: string
  text: string
}

export interface ThreadState {
  handoffs?: Record<string, Handoff | null>
  cut?: string
  keep?: number
  cleared?: number
  ratio?: number
  recalls?: Record<string, string>
}

type Note = Record<string, unknown>

export interface ContextFingerprint {
  system: string
  tools: string
  skills: string[]
  given?: ContextFingerprint
}

export interface Outgoing {
  note: Note
  threadKey: string | null
  bodyText: string | undefined
  sentSize: number
  givenSize: number
  fixedSize: number
  sent: (ContextFingerprint & { session: string | null }) | null
}

export interface Canonical {
  system: Body["system"]
  tools: Body["tools"]
}

export interface CanonicalResult {
  body: Body
  status: "applied" | "captured" | "skipped"
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

export interface Prefetched {
  reranked: boolean
  rerankError: string | null
  recalled: number
}

export interface CompactInput {
  body: Body
  config: Config
  state: ThreadState
  window: number | null
  guide: string | null
  mayCompact: boolean
  omittedBefore?: number
  decorate?: (messages: Message[]) => Message[]
  reduce?: CompactOptions["reduce"]
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
  startedAt?: number
}
