import { searchOnlyInstructions, SESSIONS_SECTION, trimInstructions, TRANSCRIPT_FALLBACK } from "../context/prompts"
import { identityReranker, recallChunks, recallFor, recallForWith, livePrompt, withRecall } from "../context/recall"
import { jevReranker, rerankKey } from "../context/rerank"
import { appendSystem, tailMessages, trimMessages } from "../context/strategies"
import { blocks, resultText, withoutCacheControl } from "../context/content"
import { splitTurns, turnFingerprint } from "../context/turns"
import type { Body, Message, Reranker } from "../context/types"
import { sessionMessages } from "../transcript/messages"
import { searchGuide } from "../transcript/search"
import { RERANK_OFF } from "../config/constants"
import type { Config } from "../config/types"
import { compact } from "./compaction"
import { DEFAULT_RATIO, FINGERPRINT_HEX_CHARS, INJECTED_BLOCK } from "./constants"
import { estimator, sizeOf, targetSize } from "./estimate"
import { loadState, saveState } from "./state"
import type { Rewrite, RewriteInput } from "./types"

const pass = (body: Body): Rewrite => ({ body, threadKey: null, note: { action: "pass" } })

const isAgentThread = (body: Body) => Array.isArray(body.tools) && body.tools.length > 0

const sectioned = (system: Body["system"], extra?: string | null) => appendSystem(extra ? appendSystem(system, extra) : system, SESSIONS_SECTION)

export function messageFingerprint(message: Message) {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(JSON.stringify(blocks(message).filter((b) => !(b.type === "text" && INJECTED_BLOCK.test(String(b.text ?? "")))).map(withoutCacheControl)))
  return hasher.digest("hex").slice(0, FINGERPRINT_HEX_CHARS)
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
  return own.length || !transcript ? own : recallChunks([...sessionMessages(transcript), { role: "user", content: "" }], kept)
}

function recallTarget(original: Body, result: Rewrite): { key: string; text: string } | null {
  if (!result.threadKey || result.body === original && result.note.action === "pass") return null
  const live = livePrompt(original.messages)
  return live ? { key: messageFingerprint(original.messages[live.index]), text: live.text } : null
}

function recalled(input: RewriteInput, original: Body, result: Rewrite, transcript: string | null): Rewrite {
  if (!result.threadKey || result.body === original && result.note.action === "pass") return result
  const state = loadState(result.threadKey)
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

interface Prefetched {
  reranked: boolean
  rerankError: string | null
  recalled: number
}

async function prefetchFor(input: RewriteInput, result: Rewrite, rerank: Reranker, failure: { reason: string | null } = { reason: null }): Promise<Prefetched | null> {
  const target = recallTarget(input.body, result)
  if (!target) return null
  const state = loadState(result.threadKey!)
  state.recalls ??= {}
  if (target.key in state.recalls) return null
  const chunks = droppedChunks(input.body, result, input.transcript?.jsonl ?? null)
  state.recalls[target.key] = (await recallForWith(target.text, chunks, rerank, { candidates: input.config.eval?.rerank?.candidates, ...input.config.eval?.recallOptions })) ?? ""
  saveState(result.threadKey!, state)
  return { reranked: rerank !== identityReranker && !failure.reason, rerankError: failure.reason, recalled: state.recalls[target.key].length }
}

export async function prefetchRecall(input: RewriteInput, rerank: Reranker): Promise<Prefetched | null> {
  if (!wantsRecall(input)) return null
  return prefetchFor(input, strategize(input), rerank)
}

function once(input: RewriteInput): Rewrite {
  const result = strategize(input)
  return wantsRecall(input) ? recalled(input, input.body, result, input.transcript?.jsonl ?? null) : result
}

function sentEstimate(result: Rewrite): number {
  return Math.round(sizeOf(result.body) * (loadState(result.threadKey!).ratio ?? DEFAULT_RATIO))
}

function overLimit(input: RewriteInput, result: Rewrite): boolean {
  if (!input.window || !result.threadKey || input.mayCompact === false || result.note.action === "pass") return false
  return sentEstimate(result) > input.config.compactAt * input.window
}

export function rewrite(input: RewriteInput): Rewrite {
  const result = once(input)
  if (!overLimit(input, result)) return result
  const recut = once(input)
  if (!overLimit(input, recut)) return { ...recut, note: { ...recut.note, fit: "recut" } }
  const bare = once({ ...input, config: { ...input.config, eval: { ...input.config.eval, recall: false } } })
  return { ...bare, note: { ...bare.note, fit: overLimit(input, bare) ? "over" : "bare", fitEstimate: sentEstimate(bare) } }
}

export async function rewriteAsync(input: RewriteInput): Promise<Rewrite> {
  if (!wantsRecall(input)) return rewrite(input)
  const model = rerankModel(input.config)
  const key = model ? rerankKey() : null
  const failure = { reason: null as string | null }
  const reranker = model && key ? jevReranker(model, key, undefined, (reason) => { failure.reason = reason }) : identityReranker
  const done = reranker !== identityReranker ? await prefetchFor(input, strategize(input), reranker, failure) : null
  const final = rewrite(input)
  if (!done) return final
  return { ...final, note: { ...final.note, recalled: done.recalled, ...(done.reranked ? { reranked: model } : {}), ...(done.rerankError ? { rerankError: `${model}: ${done.rerankError}` } : {}) } }
}

function strategize(input: RewriteInput): Rewrite {
  const { body, sessionId, config, transcript } = input
  if (config.mode === "off" || !sessionId || !Array.isArray(body.messages) || body.messages.length === 0) return pass(body)
  const { turns } = splitTurns(body.messages)
  if (turns.length === 0) return pass(body)
  const threadKey = `${sessionId}-${turnFingerprint(turns[0])}`
  const guide = transcript ? searchGuide(transcript) : null

  switch (config.eval?.strategy) {
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
      const size = estimator(based, loadState(threadKey).ratio ?? DEFAULT_RATIO)
      let from = 1
      if (config.eval.tailTurns) {
        from = Math.max(1, turns.length - config.eval.tailTurns)
      } else if (input.window) {
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
        body: { ...body, system: sectioned(body.system, trimInstructions(guide ?? TRANSCRIPT_FALLBACK)), messages },
        threadKey,
        note: { action: "trim", turns: turns.length, messagesIn: body.messages.length, messagesOut: messages.length },
      }
    }
  }

  const based = isAgentThread(body) ? { ...body, system: sectioned(body.system) } : body
  if (body.messages.length < 2) return { body: based, threadKey, note: { action: "full", turns: turns.length } }
  const state = loadState(threadKey)
  const recalls = wantsRecall(input) ? activeRecalls(state.recalls) : {}
  const decorate = (messages: Message[]) => withRecall(messages, messageFingerprint, recalls)
  const result = compact({ body: based, config, state, window: input.window, guide, mayCompact: input.mayCompact, omittedBefore: input.omittedBefore, decorate })
  if (result.stateChanged) saveState(threadKey, state)
  return {
    body: result.messages === body.messages ? based : { ...based, messages: result.messages },
    threadKey,
    note: result.note,
  }
}
