import { type Body, blocks, type Message, resultText } from "../context/content"
import { isPrompt } from "../context/fold/turns"
import { livePrompt, RECALL_CHARS_TOTAL, type RecallChunk, type RecallOptions, type Reranker, recallChunks, recallFor, recallForWith, withRecall } from "../context/recall"
import { messageFingerprint } from "./fingerprint"
import { activeHandoffs, handoffChunks } from "./handoff"
import type { Rewrite, RewriteInput } from "./rewrite"

const closingTurn: Message = { role: "user", content: "" }

export const wantsRecall = (input: RewriteInput) => (input.config.eval?.recall ?? true) && input.config.mode !== "off"

export const activeRecalls = (recalls: Record<string, string> = {}) => Object.fromEntries(Object.entries(recalls).filter(([, text]) => text))

const touched = (input: RewriteInput, result: Rewrite) => result.threadKey !== null && !(result.body === input.body && result.note.action === "pass")

function droppedChunks(input: RewriteInput, result: Rewrite, threadKey: string): RecallChunk[] {
  const sources = input.sources ?? {}
  const kept = new Map<string, string>()
  for (const message of result.body.messages) for (const b of blocks(message)) if (b.type === "tool_result") kept.set(b.tool_use_id, resultText(b))
  const own = recallChunks(input.body.messages, kept)
  const session = own.length > 0 || !sources.readHistory ? own : recallChunks([...sources.readHistory(), closingTurn], kept)
  const withSubagents = sources.listSubagentChunks ? [...session, ...sources.listSubagentChunks()] : session
  return [...handoffChunks(activeHandoffs(input.store.read(threadKey).handoffs), sources), ...withSubagents]
}

function recallTarget(original: Body): { key: string; text: string } | null {
  const live = livePrompt(original.messages)
  return live ? { key: messageFingerprint(original.messages[live.index]), text: live.text } : null
}

function charsInUse(messages: Message[], recalls: Record<string, string>): number {
  return messages.reduce((sum, message) => sum + (isPrompt(message) ? (recalls[messageFingerprint(message)]?.length ?? 0) : 0), 0)
}

const RECALL_SHARE = 0.25

const RECALL_FLOOR = 6_000

function withinTotal(input: RewriteInput, result: Rewrite, recalls: Record<string, string>): RecallOptions {
  const options = input.config.eval?.recallOptions
  const share = Math.max(RECALL_FLOOR, RECALL_SHARE * JSON.stringify(result.body.messages).length)
  return { ...options, maxCharsTotal: Math.min(options?.maxCharsTotal ?? RECALL_CHARS_TOTAL, share), charsInUse: charsInUse(result.body.messages, recalls) }
}

export function dropLiveRecall(input: RewriteInput, threadKey: string) {
  const target = recallTarget(input.body)
  if (!target) return
  const state = input.store.read(threadKey)
  if (state.recalls?.[target.key] === "") return
  state.recalls = { ...state.recalls, [target.key]: "" }
  input.store.save(threadKey, state)
}

export function applyRecall(input: RewriteInput, result: Rewrite): Rewrite {
  if (!touched(input, result) || !result.threadKey) return result
  const state = input.store.read(result.threadKey)
  state.recalls ??= {}
  const target = recallTarget(input.body)
  let note = result.note
  if (target && !(target.key in state.recalls)) {
    state.recalls[target.key] = recallFor(target.text, droppedChunks(input, result, result.threadKey), withinTotal(input, result, state.recalls)) ?? ""
    input.store.save(result.threadKey, state)
    note = { ...note, recalled: state.recalls[target.key].length }
  }
  const messages = withRecall(result.body.messages, messageFingerprint, activeRecalls(state.recalls))
  return messages === result.body.messages ? { ...result, note } : { ...result, body: { ...result.body, messages }, note }
}

export async function prefetchFor(input: RewriteInput, result: Rewrite, rerank: Reranker): Promise<number | null> {
  if (!touched(input, result) || !result.threadKey) return null
  const target = recallTarget(input.body)
  if (!target) return null
  const state = input.store.read(result.threadKey)
  state.recalls ??= {}
  if (target.key in state.recalls) return null
  const options = { candidates: input.config.eval?.rerank?.candidates, ...withinTotal(input, result, state.recalls) }
  state.recalls[target.key] = (await recallForWith(target.text, droppedChunks(input, result, result.threadKey), rerank, options)) ?? ""
  input.store.save(result.threadKey, state)
  return state.recalls[target.key].length
}
