import { type Block, contentBlocks, type Message } from "../context/content"

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

type TurnPart = { kind: "say"; text: string } | ToolPart

export interface Turn {
  number: number
  time: string
  prompt: string
  parts: TurnPart[]
  final: string
  calls: number
}

const OUTPUT_CAP = 40_000

export function parseJsonl<T = SessionEntry>(text: string): T[] {
  return text.split("\n").flatMap((line) => {
    if (!line) return []
    try {
      return [JSON.parse(line) as T]
    } catch {
      return []
    }
  })
}

export function entryMessages(entries: SessionEntry[]): Message[] {
  return entries.flatMap((entry): Message[] => {
    if (entry.isCompactSummary || (entry.type !== "user" && entry.type !== "assistant") || !entry.message) return []
    return [{ role: entry.message.role, content: entry.message.content }]
  })
}

function promptText(content: Block[]) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<system-message>[\s\S]*?<\/system-message>/g, "")
    .trim()
}

function isPrompt(entry: SessionEntry) {
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary) return false
  const content = contentBlocks(entry.message?.content)
  if (content.some((block) => block.type === "tool_result")) return false
  return Boolean(promptText(content)) || content.some((block) => block.type === "image")
}

function describeCall(block: Block): string {
  const input = block.input ?? {}
  if (typeof input.command === "string") return `\`${input.command.replace(/\s+/g, " ").slice(0, 300)}\``
  if (typeof input.file_path === "string") return input.file_path
  if (typeof input.pattern === "string") return `"${input.pattern.slice(0, 120)}"${input.path ? ` in ${input.path}` : ""}`
  if (typeof input.url === "string") return input.url
  if (typeof input.description === "string") return input.description.slice(0, 160)
  return JSON.stringify(input).slice(0, 200)
}

function callBody(block: Block): string {
  const input = block.input ?? {}
  if (typeof input.new_string === "string") return `Replaced:\n\`\`\`\n${input.old_string ?? ""}\n\`\`\`\nWith:\n\`\`\`\n${input.new_string}\n\`\`\``
  if (typeof input.content === "string" && block.name === "Write") return `\`\`\`\n${input.content.slice(0, OUTPUT_CAP)}\n\`\`\``
  return ""
}

function outputOf(block: Block): string {
  const content =
    typeof block.content === "string"
      ? block.content
      : contentBlocks(block.content)
          .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
          .join("\n")
  return content.length > OUTPUT_CAP ? `${content.slice(0, OUTPUT_CAP)}\n… [${content.length - OUTPUT_CAP} more characters]` : content
}

function promptTurn(entry: SessionEntry, number: number): Turn {
  const text = promptText(contentBlocks(entry.message?.content))
  const time = String(entry.timestamp ?? "")
    .slice(0, 16)
    .replace("T", " ")
  return { number, time, prompt: text || "[image]", parts: [], final: "", calls: 0 }
}

function recordAssistant(turn: Turn, content: Block[], pending: Map<string, ToolPart>, narration: string): string {
  let said = narration
  for (const block of content) {
    if (block.type === "text" && String(block.text).trim()) {
      said = String(block.text).trim()
      turn.final = said
    }
    if (block.type !== "tool_use") continue
    turn.calls += 1
    if (said) {
      turn.parts.push({ kind: "say", text: said })
      said = ""
    }
    turn.final = ""
    const call: ToolPart = {
      kind: "tool",
      n: turn.calls,
      id: String(block.id ?? ""),
      name: block.name,
      prompt: typeof block.input?.prompt === "string" ? block.input.prompt : undefined,
      call: describeCall(block),
      body: callBody(block),
      output: "",
      error: false,
    }
    pending.set(block.id, call)
    turn.parts.push(call)
  }
  return said
}

function recordResults(content: Block[], pending: Map<string, ToolPart>) {
  for (const block of content) {
    if (block.type !== "tool_result") continue
    const call = pending.get(block.tool_use_id)
    if (!call) continue
    pending.delete(block.tool_use_id)
    call.output = outputOf(block).trim()
    call.error = Boolean(block.is_error)
  }
}

export function parseTurns(entries: SessionEntry[], sidechain: boolean | "any" = false): Turn[] {
  const turns: Turn[] = []
  const pending = new Map<string, ToolPart>()
  let narration = ""
  for (const entry of entries) {
    if (sidechain !== "any" && Boolean(entry.isSidechain) !== sidechain) continue
    if (isPrompt(entry)) {
      turns.push(promptTurn(entry, turns.length + 1))
      continue
    }
    const turn = turns.at(-1)
    if (!turn) continue
    const content = contentBlocks(entry.message?.content)
    if (entry.type === "system" && entry.subtype === "compact_boundary") turn.parts.push({ kind: "say", text: "(Claude Code compacted the context here.)" })
    else if (entry.type === "assistant") narration = recordAssistant(turn, content, pending, narration)
    else if (entry.type === "user") recordResults(content, pending)
  }
  return turns
}
