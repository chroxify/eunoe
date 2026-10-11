export type Block = { type: string; [key: string]: any }

export type Message = { role: string; content: string | Block[] }

export type Body = {
  model?: string
  system?: string | Block[]
  messages: Message[]
  tools?: unknown[]
  metadata?: { user_id?: string }
  [key: string]: any
}

export function contentBlocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  return Array.isArray(content) ? content : []
}

export function blocks(message: Message): Block[] {
  return contentBlocks(message.content)
}

function joinedText(list: Block[]): string {
  return list
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n")
}

export function textOf(message: Message): string {
  return joinedText(blocks(message))
}

export function resultText(block: Block): string {
  return typeof block.content === "string" ? block.content : joinedText(contentBlocks(block.content))
}

export function withoutCacheControl(block: Block): Block {
  if (!("cache_control" in block)) return block
  const { cache_control: _, ...rest } = block
  return rest
}

export function clean(message: Message): Message {
  return { role: message.role, content: blocks(message).map(withoutCacheControl) }
}

export function shortHash(json: string, chars: number): string {
  return new Bun.CryptoHasher("sha256").update(json).digest("hex").slice(0, chars)
}

export function truncate(text: string, max: number): string {
  const cut = text.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

export function clip(value: unknown, max: number): string {
  const text = String(value).replace(/\s+/g, " ").trim()
  return text.length > max ? `${truncate(text, max)}…` : text
}

export function wellFormed(_key: string, value: unknown): unknown {
  return typeof value === "string" ? value.toWellFormed() : value
}

export function describeToolCall(block: Block): string {
  const input = block.input ?? {}
  if (typeof input.command === "string") return `${block.name} \`${clip(input.command, 100)}\``
  if (typeof input.file_path === "string") return `${block.name} ${input.file_path}`
  if (typeof input.pattern === "string") return `${block.name} "${clip(input.pattern, 60)}"`
  return `${block.name} ${clip(JSON.stringify(input), 60)}`
}
