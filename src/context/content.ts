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

const SHA256_ROUNDS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6,
  0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb,
  0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee,
  0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const utf8 = new TextEncoder()

const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n))

export function sha256(text: string): string {
  const data = utf8.encode(text)
  const size = ((data.length + 72) >> 6) << 6
  const bytes = new Uint8Array(size)
  bytes.set(data)
  bytes[data.length] = 0x80
  const view = new DataView(bytes.buffer)
  view.setUint32(size - 8, Math.floor(data.length / 0x20000000))
  view.setUint32(size - 4, (data.length << 3) >>> 0)
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  for (let offset = 0; offset < size; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i += 1) w[i] = (w[i - 16] + (rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 7] + (rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ (w[i - 2] >>> 10))) | 0
    let [a, b, c, d, e, f, g, k] = h
    for (let i = 0; i < 64; i += 1) {
      const t1 = (k + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_ROUNDS[i] + w[i]) | 0
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      k = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0] += a
    h[1] += b
    h[2] += c
    h[3] += d
    h[4] += e
    h[5] += f
    h[6] += g
    h[7] += k
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("")
}

export function shortHash(json: string, chars: number): string {
  return sha256(json).slice(0, chars)
}

export function quickHash(text: string): string {
  let a = 0xdeadbeef ^ text.length
  let b = 0x41c6ce57 ^ text.length
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 2654435761)
    b = Math.imul(b ^ code, 1597334677)
  }
  const high = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909)
  const low = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909)
  return `${(low >>> 0).toString(36)}${(high >>> 0).toString(36)}`
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
