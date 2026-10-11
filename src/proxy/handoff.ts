import { statSync } from "node:fs"
import { claudeConfigDirs } from "../config"
import { HANDOFF_PREAMBLE } from "../context/constants"
import { blocks } from "../context/content"
import { foldedView, sourceChunks } from "../context/fold"
import { FOLD_CAP_CHARS } from "../context/fold/constants"
import { isPrompt } from "../context/fold/turns"
import type { RecallChunk } from "../context/recall/types"
import type { Message } from "../context/types"
import { findSessionByPrefix } from "../transcript/locate"
import { sessionMessages } from "../transcript/messages"
import { CONTINUE_TRIGGER, HANDOFF_TAG, INJECTED_BLOCK } from "./constants"
import { titleOf } from "./sessions"
import type { Handoff, RewriteInput, ThreadState } from "./types"

type Fingerprint = (message: Message) => string

const ownText = (message: Message) =>
  blocks(message)
    .filter((b) => b.type === "text" && !INJECTED_BLOCK.test(String(b.text ?? "")))
    .map((b) => String(b.text ?? ""))
    .join("\n")

export const continueToken = (id: string) => `{ee:continue:${id}}`

export function continueIdOf(message: Message): string | null {
  if (!isPrompt(message)) return null
  return ownText(message).match(CONTINUE_TRIGGER)?.[1] ?? null
}

function handoffBlock(label: string, text: string): string {
  return `<${HANDOFF_TAG} from="${label}">\n${HANDOFF_PREAMBLE}\n\n${text}\n</${HANDOFF_TAG}>`
}

export const activeHandoffs = (handoffs: Record<string, Handoff | null> = {}) => Object.fromEntries(Object.entries(handoffs).filter(([, h]) => h)) as Record<string, Handoff>

export function attachHandoffs(input: RewriteInput, state: ThreadState, fingerprint: Fingerprint): boolean {
  let changed = false
  for (const message of input.body.messages) {
    const id = continueIdOf(message)
    if (!id) continue
    const key = fingerprint(message)
    if (state.handoffs && key in state.handoffs) continue
    state.handoffs ??= {}
    const file = findSessionByPrefix(id, claudeConfigDirs(input.config), input.sessionId ?? undefined)
    const already = Object.values(state.handoffs).some((h) => h?.source === file)
    state.handoffs[key] = file && !already ? { label: titleOf(file) ?? id, source: file, text: foldedView(sessionMessages(file), FOLD_CAP_CHARS) } : null
    changed = true
  }
  return changed
}

export function withHandoffs(messages: Message[], fingerprint: Fingerprint, handoffs: Record<string, Handoff>): Message[] {
  if (Object.keys(handoffs).length === 0) return messages
  return messages.map((message) => {
    if (!isPrompt(message)) return message
    const handoff = handoffs[fingerprint(message)]
    return handoff ? { ...message, content: [{ type: "text", text: handoffBlock(handoff.label, handoff.text) }, ...blocks(message)] } : message
  })
}

const sourceCache = new Map<string, { mtime: number; chunks: RecallChunk[] }>()

export function handoffChunks(handoffs: Record<string, Handoff>): RecallChunk[] {
  const out: RecallChunk[] = []
  const seen = new Set<string>()
  for (const handoff of Object.values(handoffs)) {
    if (seen.has(handoff.source)) continue
    seen.add(handoff.source)
    let mtime = 0
    try {
      mtime = statSync(handoff.source).mtimeMs
    } catch {
      continue
    }
    const cached = sourceCache.get(handoff.source)
    const chunks = cached?.mtime === mtime ? cached.chunks : sourceChunks(sessionMessages(handoff.source), handoff.label, true)
    sourceCache.set(handoff.source, { mtime, chunks })
    out.push(...chunks)
  }
  return out
}
