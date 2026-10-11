import type { Config } from "../config"
import type { Body, Message } from "../context/content"
import { appendSystem, tailMessages, trimMessages } from "../context/fold/strategies"
import { splitTurns, turnFingerprint } from "../context/fold/turns"
import { SYSTEM_PROMPT, searchGuide, searchOnlyInstructions, trimInstructions } from "../context/prompts"
import { identityReranker, type Reranker, withRecall } from "../context/recall"
import { jevReranker, rerankKey } from "../context/recall/rerank"
import type { TranscriptRef } from "../transcript/search"
import { compact } from "./compaction"
import { DEFAULT_RATIO, estimator, sizeOf, targetSize } from "./estimate"
import { messageFingerprint } from "./fingerprint"
import { activeHandoffs, attachHandoffs, withHandoffs } from "./handoff"
import { activeRecalls, applyRecall, prefetchFor, wantsRecall } from "./recall"
import { readState, saveState } from "./state"

export interface RewriteInput {
  body: Body
  sessionId: string | null
  config: Config
  transcript: TranscriptRef | null
  window: number | null
  mayCompact: boolean
  omittedBefore?: number
}

export interface Rewrite {
  body: Body
  threadKey: string | null
  note: Record<string, unknown>
}

interface Prefetched {
  reranked: boolean
  rerankError: string | null
  recalled: number
}

const pass = (body: Body): Rewrite => ({ body, threadKey: null, note: { action: "pass" } })

const isAgentThread = (body: Body) => Array.isArray(body.tools) && body.tools.length > 0

const withSystemPrompt = (system: Body["system"], extra?: string | null) => appendSystem(extra ? appendSystem(system, extra) : system, SYSTEM_PROMPT)

const ratioOf = (threadKey: string) => readState(threadKey).ratio ?? DEFAULT_RATIO

function rerankModel(config: Config): string | null {
  const model = config.eval?.rerank?.model ?? config.rerank
  return model && model !== "off" ? model : null
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
  const size = estimator(based, ratioOf(threadKey))
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
  const { body, sessionId, config, transcript } = input
  if (config.mode === "off" || !sessionId || !Array.isArray(body.messages) || body.messages.length === 0) return pass(body)
  const { turns } = splitTurns(body.messages)
  if (turns.length === 0) return pass(body)
  const threadKey = `${sessionId}-${turnFingerprint(turns[0])}`
  const guide = transcript ? searchGuide(transcript) : null
  const state = readState(threadKey)
  if (attachHandoffs(body.messages, config, sessionId, state)) saveState(threadKey, state)

  const forced = evalStrategy(input, turns, threadKey, guide)
  if (forced) return forced

  const based = isAgentThread(body) ? { ...body, system: withSystemPrompt(body.system) } : body
  if (body.messages.length < 2) return { body: based, threadKey, note: { action: "full", turns: turns.length } }
  const handoffs = activeHandoffs(state.handoffs)
  const recalls = wantsRecall(input) ? activeRecalls(state.recalls) : {}
  const result = compact({
    body: based,
    config,
    state,
    window: input.window,
    guide,
    transcriptDir: transcript && transcript.mode !== "jsonl" ? transcript.dir : null,
    mayCompact: input.mayCompact,
    omittedBefore: input.omittedBefore,
    decorate: (messages) => withRecall(withHandoffs(messages, handoffs), messageFingerprint, recalls),
  })
  if (result.stateChanged) saveState(threadKey, state)
  return { body: result.messages === body.messages ? based : { ...based, messages: result.messages }, threadKey, note: result.note }
}

function withAttachedHandoffs(result: Rewrite): Rewrite {
  if (!result.threadKey) return result
  const handoffs = activeHandoffs(readState(result.threadKey).handoffs)
  const messages = withHandoffs(result.body.messages, handoffs)
  if (messages === result.body.messages) return result
  const attached = Object.values(handoffs)
  const note = { ...result.note, handoff: attached.reduce((sum, h) => sum + h.text.length, 0), handoffFrom: attached.map((h) => h.label).join(", ") }
  return { ...result, body: { ...result.body, messages }, note }
}

function once(input: RewriteInput): Rewrite {
  const result = withAttachedHandoffs(strategize(input))
  return wantsRecall(input) ? applyRecall(input, result) : result
}

function sentEstimate(result: Rewrite): number {
  return Math.round(sizeOf(result.body) * (result.threadKey ? ratioOf(result.threadKey) : DEFAULT_RATIO))
}

function overLimit(input: RewriteInput, result: Rewrite): boolean {
  if (!input.window || !result.threadKey || input.mayCompact === false || result.note.action === "pass") return false
  return sentEstimate(result) > input.config.compactAt * input.window
}

function carried(from: Rewrite, to: Rewrite): Rewrite {
  const actionsOf = ({ note }: Rewrite) => (note.actions as string[] | undefined) ?? []
  const actions = [...actionsOf(from), ...actionsOf(to)]
  if (!from.note.compacted && actions.length === 0) return to
  return { ...to, note: { ...to.note, compacted: Boolean(to.note.compacted || from.note.compacted), actions } }
}

export function rewrite(input: RewriteInput, before?: Rewrite): Rewrite {
  const result = before ? carried(before, once(input)) : once(input)
  if (!overLimit(input, result)) return result
  const recut = carried(result, once(input))
  if (!overLimit(input, recut)) return { ...recut, note: { ...recut.note, fit: "recut" } }
  const bare = carried(recut, once({ ...input, config: { ...input.config, eval: { ...input.config.eval, recall: false } } }))
  return { ...bare, note: { ...bare.note, fit: overLimit(input, bare) ? "over" : "bare", fitEstimate: sentEstimate(bare) } }
}

export async function prefetchRecall(input: RewriteInput, rerank: Reranker): Promise<Prefetched | null> {
  if (!wantsRecall(input)) return null
  const recalled = await prefetchFor(input, strategize(input), rerank)
  return recalled === null ? null : { reranked: rerank !== identityReranker, rerankError: null, recalled }
}

export async function rewriteAsync(input: RewriteInput): Promise<Rewrite> {
  const model = wantsRecall(input) ? rerankModel(input.config) : null
  const key = model ? rerankKey() : null
  if (!model || !key) return rewrite(input)
  const failure = { reason: null as string | null }
  const reranker = jevReranker(model, key, input.config.eval?.rerank?.endpoint, (reason) => {
    failure.reason = reason
  })
  const first = strategize(input)
  const recalled = await prefetchFor(input, first, reranker)
  const final = rewrite(input, first)
  if (recalled === null) return final
  const outcome = failure.reason ? { rerankError: `${model}: ${failure.reason}` } : { reranked: model }
  return { ...final, note: { ...final.note, recalled, ...outcome } }
}
