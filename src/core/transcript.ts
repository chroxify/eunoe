import { blocks, type Message } from "../context/content"
import { isPrompt } from "../context/fold/turns"
import { searchGuide } from "../context/prompts"
import { renderIndex, renderMarkdown, renderXml, turnFile } from "../transcript/format"
import { parseTurns, type SessionEntry, type TranscriptFormat } from "../transcript/parse"

const isNote = (message: Message) => message.role === "user" && !isPrompt(message) && !blocks(message).some((b) => b.type === "tool_result")

export function renderTranscriptFiles(messages: Message[], format: TranscriptFormat = "markdown"): Record<string, string> {
  const entries: SessionEntry[] = messages.map((message) => ({ type: message.role, isMeta: isNote(message), message }))
  const turns = parseTurns(entries)
  const files: Record<string, string> = {}
  for (const turn of turns) files[turnFile(turn, format)] = format === "xml" ? renderXml(turn) : renderMarkdown(turn)
  files["index.md"] = renderIndex(turns, format)
  return files
}

export const transcriptGuide = (dir: string, format: TranscriptFormat = "markdown") => searchGuide({ mode: format, dir, jsonl: "" })
