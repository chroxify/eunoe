import type { Body, Message } from "../context/content"
import { appendSystem, tailMessages, trimMessages } from "../context/fold/strategies"
import { splitTurns, turnFingerprint } from "../context/fold/turns"
import { SYSTEM_PROMPT, searchOnlyInstructions, trimInstructions } from "../context/prompts"
import { identityReranker, type RecallChunk, type Reranker, withRecall } from "../context/recall"
import { compact, type StuckSizes } from "./compaction"
import type { CoreConfig } from "./config"
import { DEFAULT_RATIO, estimator, sizeOf, targetSize } from "./estimate"
import { messageFingerprint } from "./fingerprint"
import { activeHandoffs, attachHandoffs, withHandoffs } from "./handoff"
import { activeRecalls, applyRecall, dropLiveRecall, prefetchFor, wantsRecall } from "./recall"
import type { ThreadStore } from "./state"

export interface ThreadSources {
  guide?: string | null
  transcriptDir?: string | null
  readHistory?: () => Message[]
  listSubagentChunks?: () => RecallChunk[]
  findHandoff?: (id: string) => { label: string; source: string } | null
  readHandoff?: (source: string) => Message[]
}

export interface RewriteInput {
  body: Body
  threadId: string | null
  config: CoreConfig
  store: ThreadStore
  sources?: ThreadSources
  window: number | null
  mayCompact: boolean
  omittedBefore?: number
}

export type RewriteNote = {
  action: "pass" | "full" | "compact" | "guide" | "trim" | "tail"
  compacted?: boolean
  actions?: string[]
  cutTurn?: number | null
  omitted?: number
  folded?: number
  pinned?: number
  host?: boolean
  keep?: number
  cleared?: number
  stuck?: StuckSizes
  turns?: number
  keptTurns?: number
  messagesIn?: number
  messagesOut?: number
  estimate?: number
  window?: number | null
  fit?: "recut" | "bare" | "over"
  fitEstimate?: number
  recalled?: number
  handoff?: number
  handoffFrom?: string
}

export interface Rewrite {
  body: Body
  threadKey: string | null
  note: RewriteNote
}

const pass = (body: Body): Rewrite => ({ body, threadKey: null, note: { action: "pass" } })

const isAgentThread = (body: Body) => Array.isArray(body.tools) && body.tools.length > 0

const withSystemPrompt = (system: Body["system"], extra?: string | null) => appendSystem(extra ? appendSystem(system, extra) : system, SYSTEM_PROMPT)

const ratioOf = (input: RewriteInput, threadKey: string) => input.store.read(threadKey).ratio ?? DEFAULT_RATIO

export function threadKeyOf(threadId: string, messages: Message[]): string | null {
  const first = splitTurns(messages).turns[0]
  return first ? `${threadId}-${turnFingerprint(first)}` : null
}

function evalStrategy(input: RewriteInput, turns: Message[][], threadKey: string, guide: string | null): Rewrite | null {
  const { body, config } = input
  const strategy = config.eval?.strategy
  if (strategy !== "guide" && strategy !== "trim" && strategy !== "tail") return null
  if (!isAgentThread(body)) return pass(body)
  const counts = { turns: turns.length, messagesIn: body.messages.length }
  if (strategy === "guide") {
    return { body: { ...body, system: withSystemPrompt(body.system, guide ? searchOnlyInstructions(guide) : null) }, threadKey, note: { action: "guide", ...counts } }
  }
  if (strategy === "trim") {
    const messages = trimMessages(body.messages, { evidence: config.eval?.evidence ?? true })
    return { body: { ...body, system: withSystemPrompt(body.system, trimInstructions(guide)), messages }, threadKey, note: { action: "trim", ...counts, messagesOut: messages.length } }
  }
  const based = { ...body, system: withSystemPrompt(body.system) }
  const size = estimator(based, ratioOf(input, threadKey))
  let from = 1
  if (input.window) {
    const target = targetSize(size, input.window)
    from = turns.length - 1
    while (from > 1 && size.of(tailMessages(body.messages, from - 1, guide)) <= target) from -= 1
  }
  const messages = tailMessages(body.messages, from, guide)
  return { body: { ...based, messages }, threadKey, note: { action: "tail", keptTurns: turns.length - from, ...counts, messagesOut: messages.length, estimate: size.of(messages) } }
}

function strategize(input: RewriteInput): Rewrite {
  const { body, threadId, config, store } = input
  const sources = input.sources ?? {}
  if (!threadId || !Array.isArray(body.messages) || body.messages.length === 0) return pass(body)
  const threadKey = threadKeyOf(threadId, body.messages)
  if (!threadKey) return pass(body)
  const off = config.mode === "off"
  const state = store.read(threadKey)
  if (off && !state.host) return pass(body)
  const { turns } = splitTurns(body.messages)
  const guide = sources.guide ?? null
  if (!off && attachHandoffs(body.messages, sources, state)) store.save(threadKey, state)

  const forced = off ? null : evalStrategy(input, turns, threadKey, guide)
  if (forced) return forced

  const based = isAgentThread(body) ? { ...body, system: withSystemPrompt(body.system) } : body
  if (body.messages.length < 2) return { body: based, threadKey, note: { action: "full", turns: turns.length } }
  const handoffs = activeHandoffs(state.handoffs)
  const recalling = wantsRecall(input)
  const result = compact({
    body: based,
    config,
    state,
    window: input.window,
    guide,
    transcriptDir: sources.transcriptDir ?? null,
    mayCompact: input.mayCompact && !off,
    omittedBefore: input.omittedBefore,
    decorate: (messages) => withRecall(withHandoffs(messages, handoffs), messageFingerprint, recalling ? activeRecalls(state.recalls) : {}),
  })
  if (result.stateChanged) store.save(threadKey, state)
  return { body: result.messages === body.messages ? based : { ...based, messages: result.messages }, threadKey, note: result.note }
}

function withAttachedHandoffs(input: RewriteInput, result: Rewrite): Rewrite {
  if (!result.threadKey) return result
  const handoffs = activeHandoffs(input.store.read(result.threadKey).handoffs)
  const messages = withHandoffs(result.body.messages, handoffs)
  if (messages === result.body.messages) return result
  const attached = Object.values(handoffs)
  const note = { ...result.note, handoff: attached.reduce((sum, h) => sum + h.text.length, 0), handoffFrom: attached.map((h) => h.label).join(", ") }
  return { ...result, body: { ...result.body, messages }, note }
}

function once(input: RewriteInput): Rewrite {
  const result = withAttachedHandoffs(input, strategize(input))
  return wantsRecall(input) ? applyRecall(input, result) : result
}

function sentEstimate(input: RewriteInput, result: Rewrite): number {
  return Math.round(sizeOf(result.body) * (result.threadKey ? ratioOf(input, result.threadKey) : DEFAULT_RATIO))
}

function overLimit(input: RewriteInput, result: Rewrite): boolean {
  if (!input.window || !result.threadKey || input.mayCompact === false || result.note.action === "pass") return false
  return sentEstimate(input, result) > input.config.compactAt * input.window
}

function carried(from: Rewrite, to: Rewrite): Rewrite {
  const actions = [...(from.note.actions ?? []), ...(to.note.actions ?? [])]
  if (!from.note.compacted && actions.length === 0) return to
  return { ...to, note: { ...to.note, compacted: Boolean(to.note.compacted || from.note.compacted), actions } }
}

function withLearnedLimit(input: RewriteInput): RewriteInput {
  const threadKey = input.threadId && Array.isArray(input.body.messages) ? threadKeyOf(input.threadId, input.body.messages) : null
  const limit = threadKey ? input.store.read(threadKey).limit : undefined
  if (!limit || (input.window !== null && input.window <= limit)) return input
  return { ...input, window: limit }
}

export function rewrite(given: RewriteInput, before?: Rewrite): Rewrite {
  const input = withLearnedLimit(given)
  const result = before ? carried(before, once(input)) : once(input)
  if (!overLimit(input, result)) return result
  const recut = carried(result, once(input))
  if (!overLimit(input, recut)) return { ...recut, note: { ...recut.note, fit: "recut" } }
  if (recut.threadKey && wantsRecall(input)) dropLiveRecall(input, recut.threadKey)
  const bare = carried(recut, once(input))
  return { ...bare, note: { ...bare.note, fit: overLimit(input, bare) ? "over" : "bare", fitEstimate: sentEstimate(input, bare) } }
}

export async function prefetchRecall(given: RewriteInput, rerank: Reranker): Promise<{ reranked: boolean; rerankError: null; recalled: number } | null> {
  const input = withLearnedLimit(given)
  if (!wantsRecall(input)) return null
  const recalled = await prefetchFor(input, strategize(input), rerank)
  return recalled === null ? null : { reranked: rerank !== identityReranker, rerankError: null, recalled }
}

export async function rewriteAsync(given: RewriteInput, rerank: Reranker = identityReranker): Promise<Rewrite> {
  const input = withLearnedLimit(given)
  if (!wantsRecall(input) || rerank === identityReranker) return rewrite(input)
  const first = strategize(input)
  const recalled = await prefetchFor(input, first, rerank)
  const final = rewrite(input, first)
  return recalled === null ? final : { ...final, note: { ...final.note, recalled } }
}
