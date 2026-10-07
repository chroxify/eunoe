import type { SearchMode } from "../config/types"

export type SessionEntry = Record<string, any>

export type TranscriptFormat = "markdown" | "xml"

export interface ToolPart {
  kind: "tool"
  n: number
  name: string
  call: string
  body: string
  output: string
  error: boolean
}

export interface SayPart {
  kind: "say"
  text: string
}

export type TurnPart = SayPart | ToolPart

export interface Turn {
  number: number
  time: string
  prompt: string
  parts: TurnPart[]
  final: string
  calls: number
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
