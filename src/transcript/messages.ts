import { readFileSync, statSync } from "node:fs"
import type { Message } from "../context/types"
import { parseJsonl } from "./parse"

let cached: { file: string; mtimeMs: number; messages: Message[] } | null = null

export function sessionMessages(file: string): Message[] {
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return []
  }
  if (cached?.file === file && cached.mtimeMs === mtimeMs) return cached.messages
  const messages = parseJsonl(readFileSync(file, "utf8")).flatMap((entry): Message[] => {
    if (entry.isSidechain || entry.isCompactSummary || (entry.type !== "user" && entry.type !== "assistant") || !entry.message) return []
    return [{ role: entry.message.role, content: entry.message.content }]
  })
  cached = { file, mtimeMs, messages }
  return messages
}
