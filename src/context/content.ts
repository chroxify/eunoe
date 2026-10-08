import { SUMMARY_ARGUMENT_CHARS, SUMMARY_COMMAND_CHARS } from "./constants"
import type { Block, Message } from "./types"

export function contentBlocks(content: unknown): Block[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : []
}

export function blocks(message: Message): Block[] {
  return contentBlocks(message.content)
}

export function withoutCacheControl(block: Block): Block {
  if (!("cache_control" in block)) return block
  const { cache_control: _, ...rest } = block
  return rest
}

export function clean(message: Message): Message {
  return { role: message.role, content: blocks(message).map(withoutCacheControl) }
}

export function truncate(text: string, max: number): string {
  const cut = text.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

export function wellFormed(_key: string, value: unknown): unknown {
  return typeof value === "string" ? value.toWellFormed() : value
}

export function clip(value: unknown, max: number): string {
  const text = String(value).replace(/\s+/g, " ").trim()
  return text.length > max ? `${truncate(text, max)}…` : text
}

export function describeToolCall(block: Block): string {
  const input = block.input ?? {}
  if (typeof input.command === "string") return `${block.name} \`${clip(input.command, SUMMARY_COMMAND_CHARS)}\``
  if (typeof input.file_path === "string") return `${block.name} ${input.file_path}`
  if (typeof input.pattern === "string") return `${block.name} "${clip(input.pattern, SUMMARY_ARGUMENT_CHARS)}"`
  return `${block.name} ${clip(JSON.stringify(input), SUMMARY_ARGUMENT_CHARS)}`
}

export function resultText(block: Block): string {
  return typeof block.content === "string" ? block.content : contentBlocks(block.content).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n")
}
