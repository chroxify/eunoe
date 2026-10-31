import { blocks, type Message } from "../context/content"
import { isPrompt } from "../context/fold/turns"
import { searchGuide } from "../context/prompts"
import { renderIndex, renderMarkdown, renderSubagentMarkdown, renderSubagentXml, renderXml, type SubagentRecord, subagentFile, turnFile } from "../transcript/format"
import { parseTurns, type SessionEntry, type TranscriptFormat, type Turn } from "../transcript/parse"
import { launchTurnOf, type Subagent } from "./subagents"

export interface TranscriptOptions {
  format?: TranscriptFormat
  subagents?: Subagent[]
}

const isNote = (message: Message) => message.role === "user" && !isPrompt(message) && !blocks(message).some((b) => b.type === "tool_result")

const turnsOf = (messages: Message[], sidechain: boolean | "any" = false): Turn[] =>
  parseTurns(
    messages.map((message): SessionEntry => ({ type: message.role, isMeta: isNote(message), message })),
    sidechain,
  )

function subagentRecords(messages: Message[], turns: Turn[], subagents: Subagent[], format: TranscriptFormat): SubagentRecord[] {
  const perTurn = new Map<number, number>()
  return subagents.map((subagent) => {
    const parentTurn = launchTurnOf(messages, subagent.toolUseId)
    const k = (perTurn.get(parentTurn) ?? 0) + 1
    perTurn.set(parentTurn, k)
    const file = subagentFile(parentTurn, k, format)
    const launcher = turns[parentTurn - 1]?.parts.find((part) => part.kind === "tool" && part.id === subagent.toolUseId)
    if (launcher?.kind === "tool") launcher.record = file
    return { run: { description: subagent.description }, turns: turnsOf(subagent.messages, "any"), parentTurn, file }
  })
}

export function renderTranscriptFiles(messages: Message[], { format = "markdown", subagents = [] }: TranscriptOptions = {}): Record<string, string> {
  const turns = turnsOf(messages)
  const records = subagentRecords(messages, turns, subagents, format)
  const files: Record<string, string> = {}
  for (const turn of turns) files[turnFile(turn, format)] = format === "xml" ? renderXml(turn) : renderMarkdown(turn)
  for (const record of records) files[record.file] = format === "xml" ? renderSubagentXml(record) : renderSubagentMarkdown(record)
  files["index.md"] = renderIndex(turns, format, records)
  return files
}

export const transcriptGuide = (dir: string, format: TranscriptFormat = "markdown") => searchGuide({ mode: format, dir, jsonl: "" })
