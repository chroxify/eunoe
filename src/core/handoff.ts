import { blocks, type Message } from "../context/content"
import { FOLD_CAP_CHARS, foldedView, sourceChunks } from "../context/fold"
import { isPrompt } from "../context/fold/turns"
import { handoffBlock } from "../context/prompts"
import type { RecallChunk } from "../context/recall"
import { isInjected, messageFingerprint } from "./fingerprint"
import type { ThreadSources } from "./rewrite"
import type { Handoff, ThreadState } from "./state"

const chunksOf = new WeakMap<Message[], { label: string; chunks: RecallChunk[] }>()

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

function resolveHandoff(id: string, sources: ThreadSources, state: ThreadState): Handoff | null {
  const found = sources.findHandoff?.(id) ?? null
  if (!found || !sources.readHandoff) return null
  const already = Object.values(state.handoffs ?? {}).some((h) => h?.source === found.source)
  return already ? null : { label: found.label, source: found.source, text: foldedView(sources.readHandoff(found.source), FOLD_CAP_CHARS) }
}

export function attachHandoffs(messages: Message[], sources: ThreadSources, state: ThreadState): boolean {
  let changed = false
  for (const message of messages) {
    const id = continueIdOf(message)
    if (!id) continue
    const key = messageFingerprint(message)
    if (state.handoffs && key in state.handoffs) continue
    const handoff = resolveHandoff(id, sources, state)
    state.handoffs ??= {}
    state.handoffs[key] = handoff
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

export function handoffChunks(handoffs: Record<string, Handoff>, sources: ThreadSources): RecallChunk[] {
  const read = sources.readHandoff
  if (!read) return []
  const labels = new Map<string, string>()
  for (const handoff of Object.values(handoffs)) if (!labels.has(handoff.source)) labels.set(handoff.source, handoff.label)
  return [...labels].flatMap(([source, label]) => {
    const messages = read(source)
    const known = chunksOf.get(messages)
    if (known?.label === label) return known.chunks
    const chunks = sourceChunks(messages, label, true)
    chunksOf.set(messages, { label, chunks })
    return chunks
  })
}
