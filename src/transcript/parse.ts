import { contentBlocks } from "../context/content"
import type { Block } from "../context/types"
import { CALL_COMMAND_CHARS, CALL_DESCRIPTION_CHARS, CALL_INPUT_CHARS, CALL_PATTERN_CHARS, OUTPUT_CAP } from "./constants"
import type { SessionEntry, ToolPart, Turn } from "./types"

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

function stripReminders(text: string) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<system-message>[\s\S]*?<\/system-message>/g, "")
    .trim()
}

function promptText(content: Block[]) {
  return stripReminders(
    content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n"),
  )
}

function isPrompt(entry: SessionEntry) {
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary) return false
  const content = contentBlocks(entry.message?.content)
  if (content.some((block) => block.type === "tool_result")) return false
  return Boolean(promptText(content)) || content.some((block) => block.type === "image")
}

function describeCall(block: Block): string {
  const input = block.input ?? {}
  if (typeof input.command === "string") return `${block.name}: \`${input.command.replace(/\s+/g, " ").slice(0, CALL_COMMAND_CHARS)}\``
  if (typeof input.file_path === "string") return `${block.name}: ${input.file_path}`
  if (typeof input.pattern === "string") return `${block.name}: "${input.pattern.slice(0, CALL_PATTERN_CHARS)}"${input.path ? ` in ${input.path}` : ""}`
  if (typeof input.url === "string") return `${block.name}: ${input.url}`
  if (typeof input.description === "string") return `${block.name}: ${input.description.slice(0, CALL_DESCRIPTION_CHARS)}`
  return `${block.name}: ${JSON.stringify(input).slice(0, CALL_INPUT_CHARS)}`
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
      call: describeCall(block).slice(block.name.length + 2),
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
