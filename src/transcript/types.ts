import type { SearchMode } from "../config/types"
import type { Block } from "../context/types"

export interface SessionEntry {
  type?: string
  subtype?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  agentId?: string
  timestamp?: string
  cwd?: string
  aiTitle?: string
  message?: { role: string; content: string | Block[] }
}

export type TranscriptFormat = "markdown" | "xml"

export interface ToolPart {
  kind: "tool"
  n: number
  id: string
  name: string
  prompt?: string
  record?: string
  call: string
  body: string
  output: string
  error: boolean
}

interface SayPart {
  kind: "say"
  text: string
}

type TurnPart = SayPart | ToolPart

export interface Turn {
  number: number
  time: string
  prompt: string
  parts: TurnPart[]
  final: string
  calls: number
}

export interface SubagentRun {
  id: string
  file: string
  inline: boolean
  description: string
  toolUseId: string | null
  prompt: string
  started: string
  mtimeMs: number
}

export interface SubagentRecord {
  run: SubagentRun
  turns: Turn[]
  parentTurn: number
  file: string
}

export interface RenderResult {
  dir: string
  changed: boolean
  turns: number
}

export interface TranscriptRef {
  mode: SearchMode
  jsonl: string
  dir: string
}
