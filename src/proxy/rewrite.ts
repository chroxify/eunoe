import { searchOnlyInstructions, trimInstructions, TRANSCRIPT_FALLBACK } from "../context/prompts"
import { recallChunks, recallFor, recallForWith, livePrompt, withRecall } from "../context/recall"
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
import { DEFAULT_RATIO } from "./constants"
import { estimator, targetSize } from "./estimate"
import { loadState, saveState } from "./state"
import type { Rewrite, RewriteInput } from "./types"

const pass = (body: Body): Rewrite => ({ body, threadKey: null, note: { action: "pass" } })

const isAgentThread = (body: Body) => Array.isArray(body.tools) && body.tools.length > 0

function messageFingerprint(message: Message) {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(JSON.stringify(blocks(message).filter((b) => !(b.type === "text" && String(b.text ?? "").startsWith("<recalled-context>"))).map(withoutCacheControl)))
  return hasher.digest("hex").slice(0, 24)
}

const wantsRecall = (input: RewriteInput) => (input.config.eval?.recall ?? true) && input.config.mode !== "off"

function rerankModel(config: Config): string | null {
  const model = config.eval?.rerank?.model ?? config.rerank
  return model && model !== RERANK_OFF ? model : null
}

function droppedChunks(original: Body, result: Rewrite, transcript: string | null) {
  const kept = new Map<string, string>()
  for (const message of result.body.messages) for (const b of blocks(message)) if (b.type === "tool_result") kept.set(b.tool_use_id, resultText(b))
  const chunks = recallChunks(original.messages, kept)
  return chunks.length || !transcript ? chunks : recallChunks([...sessionMessages(transcript), { role: "user", content: "" }], kept)
}

function recallTarget(original: Body, result: Rewrite): { key: string; text: string } | null {
  if (!result.threadKey || result.body === original && result.note.action === "pass") return null
  const live = livePrompt(original.messages)
  return live ? { key: messageFingerprint(original.messages[live.index]), text: live.text } : null
}

function recalled(original: Body, result: Rewrite, transcript: string | null): Rewrite {
  if (!result.threadKey || result.body === original && result.note.action === "pass") return result
  const state = loadState(result.threadKey)
  state.recalls ??= {}
  const target = recallTarget(original, result)
  let note = result.note
  if (target && !(target.key in state.recalls)) {
    state.recalls[target.key] = recallFor(target.text, droppedChunks(original, result, transcript)) ?? ""
    saveState(result.threadKey, state)
    note = { ...note, recalled: state.recalls[target.key].length }
  }
  const recalls = Object.fromEntries(Object.entries(state.recalls).filter(([, text]) => text))
  const messages = withRecall(result.body.messages, messageFingerprint, recalls)
  return messages === result.body.messages ? { ...result, note } : { ...result, body: { ...result.body, messages }, note }
}

export async function prefetchRecall(input: RewriteInput, rerank: Reranker): Promise<boolean> {
  if (!wantsRecall(input)) return false
  const result = strategize(input)
  const target = recallTarget(input.body, result)
  if (!target) return false
  const state = loadState(result.threadKey!)
  state.recalls ??= {}
  if (target.key in state.recalls) return false
  const chunks = droppedChunks(input.body, result, input.transcript?.jsonl ?? null)
  state.recalls[target.key] = (await recallForWith(target.text, chunks, rerank, { candidates: input.config.eval?.rerank?.candidates })) ?? ""
  saveState(result.threadKey!, state)
  return true
}

export function rewrite(input: RewriteInput): Rewrite {
  const result = strategize(input)
  return wantsRecall(input) ? recalled(input.body, result, input.transcript?.jsonl ?? null) : result
}

export async function rewriteAsync(input: RewriteInput): Promise<Rewrite> {
  const model = rerankModel(input.config)
  const key = model ? rerankKey() : null
  const reranked = model && key ? await prefetchRecall(input, jevReranker(model, key)) : false
  const result = rewrite(input)
  return reranked ? { ...result, note: { ...result.note, reranked: model } } : result
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
        body: guide ? { ...body, system: appendSystem(body.system, searchOnlyInstructions(guide)) } : body,
        threadKey,
        note: { action: "guide", turns: turns.length, messagesIn: body.messages.length },
      }
    }
    case "tail": {
      if (!isAgentThread(body)) return pass(body)
      const size = estimator(body, loadState(threadKey).ratio ?? DEFAULT_RATIO)
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
        body: { ...body, messages },
        threadKey,
        note: { action: "tail", keptTurns: turns.length - from, turns: turns.length, messagesIn: body.messages.length, messagesOut: messages.length, estimate: size.of(messages) },
      }
    }
    case "trim": {
      if (!isAgentThread(body)) return pass(body)
      const messages = trimMessages(body.messages, { evidence: config.eval?.evidence ?? true })
      return {
        body: { ...body, system: appendSystem(body.system, trimInstructions(guide ?? TRANSCRIPT_FALLBACK)), messages },
        threadKey,
        note: { action: "trim", turns: turns.length, messagesIn: body.messages.length, messagesOut: messages.length },
      }
    }
  }

  if (body.messages.length < 2) return { body, threadKey, note: { action: "full", turns: turns.length } }
  const state = loadState(threadKey)
  const result = compact({ body, config, state, window: input.window, guide, mayCompact: input.mayCompact, omittedBefore: input.omittedBefore })
  if (result.stateChanged) saveState(threadKey, state)
  return {
    body: result.messages === body.messages ? body : { ...body, messages: result.messages },
    threadKey,
    note: result.note,
  }
}
