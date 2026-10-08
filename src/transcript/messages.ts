import { readFileSync, statSync } from "node:fs"
import type { Message } from "../context/types"
import type { SessionEntry } from "./types"

let cached: { file: string; mtimeMs: number; messages: Message[] } | null = null

export function sessionMessages(file: string): Message[] {
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return []
  }
  if (cached?.file === file && cached.mtimeMs === mtimeMs) return cached.messages
  const messages: Message[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue
    let entry: SessionEntry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.isSidechain || entry.isCompactSummary || (entry.type !== "user" && entry.type !== "assistant") || !entry.message) continue
    messages.push({ role: entry.message.role, content: entry.message.content })
  }
  cached = { file, mtimeMs, messages }
  return messages
}
