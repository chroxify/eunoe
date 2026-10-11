import { statSync } from "node:fs"
import { type Config, claudeConfigDirs } from "../config"
import { blocks, type Message } from "../context/content"
import { FOLD_CAP_CHARS, foldedView, sourceChunks } from "../context/fold"
import { isPrompt } from "../context/fold/turns"
import { handoffBlock } from "../context/prompts"
import type { RecallChunk } from "../context/recall"
import { findSessionByPrefix } from "../transcript/locate"
import { sessionMessages } from "../transcript/messages"
import { isInjected, messageFingerprint } from "./fingerprint"
import { titleOf } from "./sessions"
import type { Handoff, ThreadState } from "./state"

const sourceCache = new Map<string, { mtime: number; chunks: RecallChunk[] }>()

export const continueToken = (id: string) => `{ee:continue:${id}}`

export function continueIdOf(message: Message): string | null {
  if (!isPrompt(message)) return null
  const own = blocks(message)
    .filter((b) => b.type === "text" && !isInjected(b.text))
    .map((b) => String(b.text ?? ""))
    .join("\n")
  return own.match(/\{ee:continue:([A-Za-z0-9-]{8,})\}/)?.[1] ?? null
}

export function activeHandoffs(handoffs: Record<string, Handoff | null> = {}): Record<string, Handoff> {
  return Object.fromEntries(Object.entries(handoffs).filter((entry): entry is [string, Handoff] => Boolean(entry[1])))
}

export function attachHandoffs(messages: Message[], config: Config, sessionId: string | null, state: ThreadState): boolean {
  let changed = false
  for (const message of messages) {
    const id = continueIdOf(message)
    if (!id) continue
    const key = messageFingerprint(message)
    if (state.handoffs && key in state.handoffs) continue
    state.handoffs ??= {}
    const file = findSessionByPrefix(id, claudeConfigDirs(config), sessionId ?? undefined)
    const already = Object.values(state.handoffs).some((h) => h?.source === file)
    state.handoffs[key] = file && !already ? { label: titleOf(file) ?? id, source: file, text: foldedView(sessionMessages(file), FOLD_CAP_CHARS) } : null
    changed = true
  }
  return changed
}

export function withHandoffs(messages: Message[], handoffs: Record<string, Handoff>): Message[] {
  if (Object.keys(handoffs).length === 0) return messages
  return messages.map((message) => {
    if (!isPrompt(message)) return message
    const handoff = handoffs[messageFingerprint(message)]
    return handoff ? { ...message, content: [{ type: "text", text: handoffBlock(handoff.label, handoff.text) }, ...blocks(message)] } : message
  })
}

export function handoffChunks(handoffs: Record<string, Handoff>): RecallChunk[] {
  const sources = new Map<string, string>()
  for (const handoff of Object.values(handoffs)) if (!sources.has(handoff.source)) sources.set(handoff.source, handoff.label)
  return [...sources].flatMap(([source, label]) => {
    let mtime: number
    try {
      mtime = statSync(source).mtimeMs
    } catch {
      return []
    }
    const cached = sourceCache.get(source)
    const chunks = cached?.mtime === mtime ? cached.chunks : sourceChunks(sessionMessages(source), label, true)
    sourceCache.set(source, { mtime, chunks })
    return chunks
  })
}
