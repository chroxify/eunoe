import { closeSync, openSync, readSync, statSync } from "node:fs"
import type { SessionEntry } from "./parse"

interface Parsed {
  size: number
  mtimeMs: number
  offset: number
  seam: Buffer
  committed: SessionEntry[]
  entries: SessionEntry[]
}

const BUDGET_BYTES = 768 * 1024 * 1024
const NEWLINE = 0x0a
const SEAM_BYTES = 64

const parsed = new Map<string, Parsed>()
let heldBytes = 0

function parseLines(text: string): SessionEntry[] {
  const out: SessionEntry[] = []
  for (const line of text.split("\n")) {
    if (!line) continue
    try {
      out.push(JSON.parse(line) as SessionEntry)
    } catch {}
  }
  return out
}

function readRange(file: string, from: number, to: number): Buffer {
  const buffer = Buffer.allocUnsafe(Math.max(0, to - from))
  const fd = openSync(file, "r")
  try {
    let read = 0
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, from + read)
      if (n === 0) break
      read += n
    }
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function remember(file: string, next: Parsed) {
  heldBytes += next.size - (parsed.get(file)?.size ?? 0)
  parsed.delete(file)
  parsed.set(file, next)
  for (const [key, value] of parsed) {
    if (heldBytes <= BUDGET_BYTES || key === file) break
    parsed.delete(key)
    heldBytes -= value.size
  }
}

function appendable(file: string, known: Parsed | undefined, size: number): known is Parsed {
  if (!known || size < known.size || known.offset === 0) return false
  return readRange(file, known.offset - known.seam.length, known.offset).equals(known.seam)
}

export function readSessionEntries(file: string): SessionEntry[] {
  let size: number
  let mtimeMs: number
  try {
    ;({ size, mtimeMs } = statSync(file))
  } catch {
    return []
  }
  const known = parsed.get(file)
  if (known && known.size === size && known.mtimeMs === mtimeMs) {
    parsed.delete(file)
    parsed.set(file, known)
    return known.entries
  }
  const appended = appendable(file, known, size)
  const from = appended ? known.offset : 0
  const bytes = readRange(file, from, size)
  const complete = bytes.lastIndexOf(NEWLINE) + 1
  const added = parseLines(bytes.subarray(0, complete).toString("utf8"))
  const committed = appended ? (added.length > 0 ? known.committed.concat(added) : known.committed) : added
  const tail = parseLines(bytes.subarray(complete).toString("utf8"))
  const entries = tail.length > 0 ? committed.concat(tail) : committed
  const offset = from + complete
  const seam = readRange(file, Math.max(0, offset - SEAM_BYTES), offset)
  remember(file, { size, mtimeMs, offset, seam, committed, entries })
  return entries
}
