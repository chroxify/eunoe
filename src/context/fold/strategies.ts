import { type Block, type Body, blocks, clean, type Message, truncate, withoutCacheControl } from "../content"
import { clearedInput, compactionNotice, truncationNotice } from "../prompts"
import { hasContent, isHarness, isStaleNote, type ReduceOptions, reduceTurn, splitTurns, turnFingerprint } from "./turns"

export interface CompactOptions extends ReduceOptions {
  keepTurns: number
  capChars?: number
  guide: string | null
  omittedBefore?: number
  reduce?: (turn: Message[], options: ReduceOptions) => Message[]
  pinned?: ReadonlySet<string>
}

const pinnedBy =
  ({ pinned }: CompactOptions) =>
  (turn: Message[]) =>
    pinned !== undefined && pinned.size > 0 && pinned.has(turnFingerprint(turn))

export const countPinned = (turns: Message[][], pinned: ReadonlySet<string>) => (pinned.size > 0 ? turns.filter((turn) => pinned.has(turnFingerprint(turn))).length : 0)

export function trimMessages(messages: Message[], options: ReduceOptions = {}): Message[] {
  const { preamble, turns } = splitTurns(messages)
  if (turns.length < 2) return messages
  return [...preamble, ...turns.slice(0, -1).flatMap((turn) => reduceTurn(turn, options)), ...(turns.at(-1) ?? [])]
}

export const CARRIED_CHARS = 80_000

function carriedHarness(removed: Message[]): Block[] {
  const texts = removed
    .filter((m) => isHarness(m) && hasContent(m))
    .flatMap((m) => blocks(m).filter((b) => b.type === "text"))
    .map((b) => String(b.text ?? ""))
    .filter((text) => text.trim() && !isStaleNote(text))
  const kept: string[] = []
  const seen = new Set<string>()
  let used = 0
  for (const text of texts.toReversed()) {
    if (seen.has(text) || used + text.length > CARRIED_CHARS) continue
    seen.add(text)
    kept.push(text)
    used += text.length
  }
  return kept.toReversed().map((text) => ({ type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` }))
}

export const foldsOpening = (opening: Message[], keptFrom: number) => keptFrom === 1 && opening.length > 1

export function compactMessages(messages: Message[], cutIndex: number, options: CompactOptions): Message[] {
  const { preamble, turns } = splitTurns(messages)
  if (cutIndex <= 0 || cutIndex >= turns.length) return messages
  const reduce = options.reduce ?? reduceTurn
  const isPinned = pinnedBy(options)
  const keptFrom = Math.max(1, cutIndex - options.keepTurns)
  const [first, ...rest] = turns[0]
  const openingPinned = isPinned(turns[0])
  const openingFolded = !openingPinned && foldsOpening(turns[0], keptFrom)
  const dropped = turns.slice(1, keptFrom)
  const whole = dropped.filter(isPinned)
  const pinned = whole.length + turns.slice(keptFrom, cutIndex).filter(isPinned).length + (openingPinned ? 1 : 0)
  const kept = cutIndex - keptFrom + (openingFolded ? 1 : 0)
  const notice = compactionNotice({ omitted: dropped.length - whole.length + (options.omittedBefore ?? 0), kept, pinned, guide: options.guide })
  const removed = [...(openingPinned || openingFolded ? [] : rest), ...dropped.filter((turn) => !isPinned(turn)).flat()]
  const shown = (turn: Message[]) => (isPinned(turn) ? turn.map(clean) : reduce(turn, options))
  return [
    ...preamble,
    first,
    ...(openingPinned ? rest.map(clean) : []),
    { role: "user", content: [{ type: "text", text: notice }, ...carriedHarness(removed)] },
    ...(openingFolded ? reduce(turns[0], options).slice(1) : []),
    ...whole.flatMap((turn) => turn.map(clean)),
    ...turns.slice(keptFrom, cutIndex).flatMap(shown),
    ...turns.slice(cutIndex).flat(),
  ]
}

export function capTurns(messages: Message[], options: CompactOptions): Message[] {
  const { capChars } = options
  if (!capChars) return messages
  const { preamble, turns } = splitTurns(messages)
  if (turns.length < 3) return messages
  const live = turns.length - 1
  const isPinned = pinnedBy(options)
  const over = (turn: Message[], i: number) => i > 0 && i < live && !isPinned(turn) && JSON.stringify(turn).length > capChars
  if (!turns.some(over)) return messages
  const reduce = options.reduce ?? reduceTurn
  return [...preamble, ...turns.flatMap((turn, i) => (over(turn, i) ? reduce(turn, options) : turn))]
}

export function tailMessages(messages: Message[], from: number, guide: string | null): Message[] {
  const { preamble, turns } = splitTurns(messages)
  if (turns.length === 0 || from <= 1) return messages
  const notice = truncationNotice({ omitted: from - 1, kept: turns.length - from, guide })
  return [...preamble, turns[0][0], { role: "user", content: [{ type: "text", text: notice }] }, ...turns.slice(from).flat()]
}

export function countToolResults(messages: Message[], from: number): number {
  return messages
    .slice(from)
    .filter((m) => m.role === "user")
    .reduce((total, m) => total + blocks(m).filter((b) => b.type === "tool_result").length, 0)
}

function shortenInput(input: unknown): unknown {
  if (typeof input === "string") return input.length > 2_000 ? clearedInput(truncate(input, 500), input.length - 500) : input
  if (Array.isArray(input)) return input.map(shortenInput)
  if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, shortenInput(v)]))
  return input
}

export function clearToolResults(messages: Message[], from: number, count: number, placeholder: string): Message[] {
  let left = count
  const cleared = new Set<string>()
  const clearResult = (b: Block): Block => {
    if (b.type !== "tool_result" || left <= 0) return b
    left -= 1
    cleared.add(b.tool_use_id)
    return { type: "tool_result", tool_use_id: b.tool_use_id, ...(b.is_error ? { is_error: true } : {}), content: placeholder }
  }
  const withResultsCleared = messages.map((message, index) => {
    if (left <= 0 || index < from || message.role !== "user" || typeof message.content === "string") return message
    if (!message.content.some((b) => b.type === "tool_result")) return message
    return { ...message, content: message.content.map(clearResult) }
  })
  const isClearedCall = (b: Block) => b.type === "tool_use" && cleared.has(b.id)
  return withResultsCleared.map((message) => {
    if (message.role !== "assistant" || typeof message.content === "string" || !message.content.some(isClearedCall)) return message
    return { ...message, content: message.content.map((b) => (isClearedCall(b) ? { ...b, input: shortenInput(b.input) } : b)) }
  })
}

export function appendSystem(system: Body["system"], text: string): Block[] {
  const list: Block[] = typeof system === "string" ? [{ type: "text", text: system }] : [...(system ?? [])]
  const lastCached = list.findLastIndex((b) => b.cache_control)
  const cacheControl = lastCached >= 0 ? list[lastCached].cache_control : undefined
  if (lastCached >= 0) list[lastCached] = withoutCacheControl(list[lastCached])
  list.push({ type: "text", text, ...(cacheControl ? { cache_control: cacheControl } : {}) })
  return list
}
