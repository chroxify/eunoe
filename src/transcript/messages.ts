import type { Message } from "../context/content"
import { readSessionEntries } from "./entries"
import { entryMessages, type SessionEntry } from "./parse"

const KEPT_SESSIONS = 32

const cached = new Map<string, { entries: SessionEntry[]; messages: Message[] }>()

export function sessionMessages(file: string): Message[] {
  const entries = readSessionEntries(file)
  const known = cached.get(file)
  cached.delete(file)
  if (known?.entries === entries) {
    cached.set(file, known)
    return known.messages
  }
  const messages = entryMessages(entries.filter((entry) => !entry.isSidechain))
  cached.set(file, { entries, messages })
  if (cached.size > KEPT_SESSIONS) cached.delete(cached.keys().next().value as string)
  return messages
}
