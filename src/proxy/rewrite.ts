import { RERANK_OFF } from "../config/constants"
import type { Config } from "../config/types"
import { SESSIONS_SECTION } from "../context/constants"
import { blocks, resultText, shortHash, withoutCacheControl } from "../context/content"
import { appendSystem, tailMessages, trimMessages } from "../context/fold/strategies"
import { splitTurns, turnFingerprint } from "../context/fold/turns"
import { searchOnlyInstructions, trimInstructions } from "../context/prompts"
import { identityReranker, livePrompt, recallChunks, recallFor, recallForWith, withRecall } from "../context/recall"
import { jevReranker, rerankKey } from "../context/recall/rerank"
import type { Reranker } from "../context/recall/types"
import type { Body, Message } from "../context/types"
import { sessionMessages } from "../transcript/messages"
import { searchGuide } from "../transcript/search"
import { subagentChunks } from "../transcript/subagents"
import { compact } from "./compaction"
import { DEFAULT_RATIO, FINGERPRINT_HEX_CHARS, INJECTED_BLOCK } from "./constants"
import { estimator, sizeOf, targetSize } from "./estimate"
import { activeHandoffs, attachHandoffs, handoffChunks, withHandoffs } from "./handoff"
import { readState, saveState } from "./state"
import type { Prefetched, Rewrite, RewriteInput } from "./types"

const pass = (body: Body): Rewrite => ({ body, threadKey: null, note: { action: "pass" } })

const isAgentThread = (body: Body) => Array.isArray(body.tools) && body.tools.length > 0

const sectioned = (system: Body["system"], extra?: string | null) => appendSystem(extra ? appendSystem(system, extra) : system, SESSIONS_SECTION)

export function messageFingerprint(message: Message) {
  const own = blocks(message)
    .filter((b) => !(b.type === "text" && INJECTED_BLOCK.test(String(b.text ?? ""))))
    .map(withoutCacheControl)
  return shortHash(JSON.stringify(own), FINGERPRINT_HEX_CHARS)
}

const activeRecalls = (recalls: Record<string, string> = {}) => Object.fromEntries(Object.entries(recalls).filter(([, text]) => text))

const wantsRecall = (input: RewriteInput) => (input.config.eval?.recall ?? true) && input.config.mode !== "off"

function rerankModel(config: Config): string | null {
  const model = config.eval?.rerank?.model ?? config.rerank
  return model && model !== RERANK_OFF ? model : null
}

function droppedChunks(original: Body, result: Rewrite, transcript: string | null) {
  const kept = new Map<string, string>()
  for (const message of result.body.messages) for (const b of blocks(message)) if (b.type === "tool_result") kept.set(b.tool_use_id, resultText(b))
  const own = recallChunks(original.messages, kept)
  const session = own.length > 0 || !transcript ? own : recallChunks([...sessionMessages(transcript), { role: "user", content: "" }], kept)
  const all = transcript ? [...session, ...subagentChunks(transcript)] : session
  const handoffs = result.threadKey ? activeHandoffs(readState(result.threadKey).handoffs) : {}
  return [...handoffChunks(handoffs), ...all]
}

function handed(result: Rewrite): Rewrite {
  if (!result.threadKey) return result
  const handoffs = activeHandoffs(readState(result.threadKey).handoffs)
  const messages = withHandoffs(result.body.messages, messageFingerprint, handoffs)
  if (messages === result.body.messages) return result
  const attached = Object.values(handoffs)
  return { ...result, body: { ...result.body, messages }, note: { ...result.note, handoff: attached.reduce((sum, h) => sum + h.text.length, 0), handoffFrom: attached.map((h) => h.label).join(", ") } }
}

function recallTarget(original: Body, result: Rewrite): { key: string; text: string } | null {
  if (!result.threadKey || (result.body === original && result.note.action === "pass")) return null
  const live = livePrompt(original.messages)
  return live ? { key: messageFingerprint(original.messages[live.index]), text: live.text } : null
}

function recalled(input: RewriteInput, original: Body, result: Rewrite, transcript: string | null): Rewrite {
  if (!result.threadKey || (result.body === original && result.note.action === "pass")) return result
  const state = readState(result.threadKey)
  state.recalls ??= {}
  const target = recallTarget(original, result)
  let note = result.note
  if (target && !(target.key in state.recalls)) {
    state.recalls[target.key] = recallFor(target.text, droppedChunks(original, result, transcript), input.config.eval?.recallOptions) ?? ""
    saveState(result.threadKey, state)
    note = { ...note, recalled: state.recalls[target.key].length }
  }
  const messages = withRecall(result.body.messages, messageFingerprint, activeRecalls(state.recalls))
  return messages === result.body.messages ? { ...result, note } : { ...result, body: { ...result.body, messages }, note }
}

async function prefetchFor(input: RewriteInput, result: Rewrite, rerank: Reranker, failure: { reason: string | null } = { reason: null }): Promise<Prefetched | null> {
  const target = recallTarget(input.body, result)
  if (!target) return null
  const state = readState(result.threadKey!)
  state.recalls ??= {}
  if (target.key in state.recalls) return null
  const chunks = droppedChunks(input.body, result, input.transcript?.jsonl ?? null)
  state.recalls[target.key] = (await recallForWith(target.text, chunks, rerank, { candidates: input.config.eval?.rerank?.candidates, ...input.config.eval?.recallOptions })) ?? ""
  saveState(result.threadKey!, state)
  return { reranked: rerank !== identityReranker && !failure.reason, rerankError: failure.reason, recalled: state.recalls[target.key].length }
}

export function prefetchRecall(input: RewriteInput, rerank: Reranker): Promise<Prefetched | null> {
  if (!wantsRecall(input)) return Promise.resolve(null)
  return prefetchFor(input, strategize(input), rerank)
}

function once(input: RewriteInput): Rewrite {
  const result = handed(strategize(input))
  return wantsRecall(input) ? recalled(input, input.body, result, input.transcript?.jsonl ?? null) : result
}

function sentEstimate(result: Rewrite): number {
  return Math.round(sizeOf(result.body) * (readState(result.threadKey!).ratio ?? DEFAULT_RATIO))
}

function overLimit(input: RewriteInput, result: Rewrite): boolean {
  if (!input.window || !result.threadKey || input.mayCompact === false || result.note.action === "pass") return false
  return sentEstimate(result) > input.config.compactAt * input.window
}

function carried(from: Rewrite, to: Rewrite): Rewrite {
  const actions = [...((from.note.actions as string[] | undefined) ?? []), ...((to.note.actions as string[] | undefined) ?? [])]
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

export async function rewriteAsync(input: RewriteInput): Promise<Rewrite> {
  if (!wantsRecall(input)) return rewrite(input)
  const model = rerankModel(input.config)
  const key = model ? rerankKey() : null
  const failure = { reason: null as string | null }
  const reranker =
    model && key
      ? jevReranker(model, key, input.config.eval?.rerank?.endpoint, (reason) => {
          failure.reason = reason
        })
      : identityReranker
  const first = reranker !== identityReranker ? strategize(input) : null
  const done = first && (await prefetchFor(input, first, reranker, failure))
  const final = rewrite(input, first ?? undefined)
  if (!done) return final
  return { ...final, note: { ...final.note, recalled: done.recalled, ...(done.reranked ? { reranked: model } : {}), ...(done.rerankError ? { rerankError: `${model}: ${done.rerankError}` } : {}) } }
}

function evalStrategy(input: RewriteInput, turns: Message[][], threadKey: string, guide: string | null): Rewrite | null {
  const { body, config } = input
  switch (config.eval?.strategy) {
    case undefined:
      return null
    case "guide": {
      if (!isAgentThread(body)) return pass(body)
      return {
        body: { ...body, system: sectioned(body.system, guide ? searchOnlyInstructions(guide) : null) },
        threadKey,
        note: { action: "guide", turns: turns.length, messagesIn: body.messages.length },
      }
    }
    case "tail": {
      if (!isAgentThread(body)) return pass(body)
      const based = { ...body, system: sectioned(body.system) }
      const size = estimator(based, readState(threadKey).ratio ?? DEFAULT_RATIO)
      let from = 1
      if (input.window) {
        const target = targetSize(size, input.window)
        from = turns.length - 1
        while (from > 1 && size.of(tailMessages(body.messages, from - 1, guide)) <= target) from -= 1
      }
      const messages = tailMessages(body.messages, from, guide)
      return {
        body: { ...based, messages },
        threadKey,
        note: { action: "tail", keptTurns: turns.length - from, turns: turns.length, messagesIn: body.messages.length, messagesOut: messages.length, estimate: size.of(messages) },
      }
    }
    case "trim": {
      if (!isAgentThread(body)) return pass(body)
      const messages = trimMessages(body.messages, { evidence: config.eval?.evidence ?? true })
      return {
        body: { ...body, system: sectioned(body.system, trimInstructions(guide)), messages },
        threadKey,
        note: { action: "trim", turns: turns.length, messagesIn: body.messages.length, messagesOut: messages.length },
      }
    }
  }
}

function strategize(input: RewriteInput): Rewrite {
  const { body, sessionId, config, transcript } = input
  if (config.mode === "off" || !sessionId || !Array.isArray(body.messages) || body.messages.length === 0) return pass(body)
  const { turns } = splitTurns(body.messages)
  if (turns.length === 0) return pass(body)
  const threadKey = `${sessionId}-${turnFingerprint(turns[0])}`
  const guide = transcript ? searchGuide(transcript) : null
  const state = readState(threadKey)
  if (attachHandoffs(input, state, messageFingerprint)) saveState(threadKey, state)
  const handoffs = activeHandoffs(state.handoffs)

  const forced = evalStrategy(input, turns, threadKey, guide)
  if (forced) return forced

  const based = isAgentThread(body) ? { ...body, system: sectioned(body.system) } : body
  if (body.messages.length < 2) return { body: based, threadKey, note: { action: "full", turns: turns.length } }
  const recalls = wantsRecall(input) ? activeRecalls(state.recalls) : {}
  const decorate = (messages: Message[]) => withRecall(withHandoffs(messages, messageFingerprint, handoffs), messageFingerprint, recalls)
  const result = compact({ body: based, config, state, window: input.window, guide, mayCompact: input.mayCompact, omittedBefore: input.omittedBefore, decorate })
  if (result.stateChanged) saveState(threadKey, state)
  return {
    body: result.messages === body.messages ? based : { ...based, messages: result.messages },
    threadKey,
    note: result.note,
  }
}
