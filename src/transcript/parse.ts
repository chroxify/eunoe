import { contentBlocks } from "../context/content"
import type { Block } from "../context/types"
import { CALL_COMMAND_CHARS, CALL_DESCRIPTION_CHARS, CALL_INPUT_CHARS, CALL_PATTERN_CHARS, OUTPUT_CAP } from "./constants"
import type { SessionEntry, ToolPart, Turn } from "./types"

function stripReminders(text: string) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<system-message>[\s\S]*?<\/system-message>/g, "")
    .trim()
}

function isPrompt(entry: SessionEntry) {
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary || entry.isSidechain) return false
  const content = contentBlocks(entry.message?.content)
  if (content.some((block) => block.type === "tool_result")) return false
  const text = stripReminders(content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n"))
  return Boolean(text) || content.some((block) => block.type === "image")
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

function resultText(block: Block): string {
  const content = typeof block.content === "string"
    ? block.content
    : contentBlocks(block.content).map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n")
  return content.length > OUTPUT_CAP ? `${content.slice(0, OUTPUT_CAP)}\n… [${content.length - OUTPUT_CAP} more characters]` : content
}

export function parseTurns(entries: SessionEntry[]): Turn[] {
  const turns: Turn[] = []
  const pending = new Map<string, ToolPart>()
  let narration = ""
  for (const entry of entries) {
    if (entry.isSidechain) continue
    if (isPrompt(entry)) {
      const text = stripReminders(contentBlocks(entry.message.content).filter((block) => block.type === "text").map((block) => block.text).join("\n"))
      turns.push({ number: turns.length + 1, time: String(entry.timestamp ?? "").slice(0, 16).replace("T", " "), prompt: text || "[image]", parts: [], final: "", calls: 0 })
      continue
    }
    const turn = turns.at(-1)
    if (!turn) continue
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      turn.parts.push({ kind: "say", text: "(Claude Code compacted the context here.)" })
      continue
    }
    if (entry.type === "assistant") {
      for (const block of contentBlocks(entry.message?.content)) {
        if (block.type === "text" && String(block.text).trim()) {
          narration = String(block.text).trim()
          turn.final = narration
        }
        if (block.type === "tool_use") {
          turn.calls += 1
          if (narration) {
            turn.parts.push({ kind: "say", text: narration })
            narration = ""
          }
          turn.final = ""
          const call: ToolPart = { kind: "tool", n: turn.calls, name: block.name, call: describeCall(block).slice(block.name.length + 2), body: callBody(block), output: "", error: false }
          pending.set(block.id, call)
          turn.parts.push(call)
        }
      }
    }
    if (entry.type === "user") {
      for (const block of contentBlocks(entry.message?.content)) {
        if (block.type !== "tool_result") continue
        const call = pending.get(block.tool_use_id)
        if (!call) continue
        pending.delete(block.tool_use_id)
        call.output = resultText(block).trim()
        call.error = Boolean(block.is_error)
      }
    }
  }
  return turns
}
