import { CLEARED_INPUT_KEPT, CLEARED_INPUT_THRESHOLD } from "./constants"
import { blocks, withoutCacheControl } from "./content"
import { compactionNotice, truncationNotice } from "./prompts"
import { hasContent, isHarness, reduceTurn, splitTurns } from "./turns"
import type { Block, Body, CompactOptions, Message } from "./types"

export function trimMessages(messages: Message[]): Message[] {
  const { preamble, turns } = splitTurns(messages)
  if (turns.length < 2) return messages
  return [...preamble, ...turns.slice(0, -1).flatMap(reduceTurn), ...turns.at(-1)!]
}

export function compactMessages(
  messages: Message[],
  cutIndex: number,
  options: CompactOptions,
): Message[] {
  const { preamble, turns } = splitTurns(messages)
  if (cutIndex <= 0 || cutIndex >= turns.length) return messages
  const keptFrom = Math.max(1, cutIndex - options.keepTurns)
  const notice = compactionNotice({ omitted: keptFrom - 1 + (options.omittedBefore ?? 0), kept: cutIndex - keptFrom, guide: options.guide })
  const removed = [...turns[0].slice(1), ...turns.slice(1, keptFrom).flat()]
  const carried = removed
    .filter((m) => isHarness(m) && hasContent(m))
    .flatMap((m) => blocks(m).filter((b) => b.type === "text"))
    .map((b) => ({ type: "text", text: `<system-reminder>\n${b.text}\n</system-reminder>` }))
  return [
    ...preamble,
    turns[0][0],
    { role: "user", content: [{ type: "text", text: notice }, ...carried] },
    ...turns.slice(keptFrom, cutIndex).flatMap(reduceTurn),
    ...turns.slice(cutIndex).flat(),
  ]
}

export function tailMessages(messages: Message[], from: number, guide: string | null): Message[] {
  const { preamble, turns } = splitTurns(messages)
  if (turns.length === 0 || from <= 1) return messages
  const notice = truncationNotice({ omitted: from - 1, kept: turns.length - from, guide })
  return [
    ...preamble,
    turns[0][0],
    { role: "user", content: [{ type: "text", text: notice }] },
    ...turns.slice(from).flat(),
  ]
}

export function countToolResults(messages: Message[], from: number): number {
  return messages.slice(from).reduce((total, m) => total + (m.role === "user" ? blocks(m).filter((b) => b.type === "tool_result").length : 0), 0)
}

export function clearToolResults(messages: Message[], from: number, count: number, placeholder: string): Message[] {
  let left = count
  const cleared = new Set<string>()
  const results = messages.map((message, index) => {
    if (left <= 0 || index < from || message.role !== "user" || typeof message.content === "string") return message
    if (!message.content.some((b) => b.type === "tool_result")) return message
    return {
      ...message,
      content: message.content.map((b) => {
        if (b.type !== "tool_result" || left <= 0) return b
        left -= 1
        cleared.add(b.tool_use_id)
        return { type: "tool_result", tool_use_id: b.tool_use_id, ...(b.is_error ? { is_error: true } : {}), content: placeholder }
      }),
    }
  })
  return results.map((message) => {
    if (message.role !== "assistant" || typeof message.content === "string") return message
    if (!message.content.some((b) => b.type === "tool_use" && cleared.has(b.id))) return message
    return { ...message, content: message.content.map((b) => (b.type === "tool_use" && cleared.has(b.id) ? { ...b, input: shortenInput(b.input) } : b)) }
  })
}

function shortenInput(input: unknown): unknown {
  if (typeof input === "string") return input.length > CLEARED_INPUT_THRESHOLD ? `${input.slice(0, CLEARED_INPUT_KEPT)}… [${input.length - CLEARED_INPUT_KEPT} chars cleared; in the transcript]` : input
  if (Array.isArray(input)) return input.map(shortenInput)
  if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, shortenInput(v)]))
  return input
}

export function appendSystem(system: Body["system"], text: string): Block[] {
  const list: Block[] = typeof system === "string" ? [{ type: "text", text: system }] : [...(system ?? [])]
  const lastCached = list.findLastIndex((b) => b.cache_control)
  const cacheControl = lastCached >= 0 ? list[lastCached].cache_control : undefined
  if (lastCached >= 0) list[lastCached] = withoutCacheControl(list[lastCached])
  list.push({ type: "text", text, ...(cacheControl ? { cache_control: cacheControl } : {}) })
  return list
}
