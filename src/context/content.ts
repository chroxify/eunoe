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

export function clip(value: unknown, max: number): string {
  const text = String(value).replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}
