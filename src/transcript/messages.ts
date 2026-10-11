import { readFileSync, statSync } from "node:fs"
import type { Message } from "../context/content"
import { entryMessages, parseJsonl } from "./parse"

let cached: { file: string; mtimeMs: number; messages: Message[] } | null = null

export function sessionMessages(file: string): Message[] {
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return []
  }
  if (cached?.file === file && cached.mtimeMs === mtimeMs) return cached.messages
  const messages = entryMessages(parseJsonl(readFileSync(file, "utf8")).filter((entry) => !entry.isSidechain))
  cached = { file, mtimeMs, messages }
  return messages
}
