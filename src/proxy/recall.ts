import { type Body, blocks, resultText } from "../context/content"
import { livePrompt, type RecallChunk, type Reranker, recallChunks, recallFor, recallForWith, withRecall } from "../context/recall"
import { sessionMessages } from "../transcript/messages"
import { subagentChunks } from "../transcript/subagents"
import { messageFingerprint } from "./fingerprint"
import { activeHandoffs, handoffChunks } from "./handoff"
import type { Rewrite, RewriteInput } from "./rewrite"
import { readState, saveState } from "./state"

export const wantsRecall = (input: RewriteInput) => (input.config.eval?.recall ?? true) && input.config.mode !== "off"

export const activeRecalls = (recalls: Record<string, string> = {}) => Object.fromEntries(Object.entries(recalls).filter(([, text]) => text))

const touched = (input: RewriteInput, result: Rewrite) => result.threadKey !== null && !(result.body === input.body && result.note.action === "pass")

function droppedChunks(input: RewriteInput, result: Rewrite): RecallChunk[] {
  const transcript = input.transcript?.jsonl ?? null
  const kept = new Map<string, string>()
  for (const message of result.body.messages) for (const b of blocks(message)) if (b.type === "tool_result") kept.set(b.tool_use_id, resultText(b))
  const own = recallChunks(input.body.messages, kept)
  const session = own.length > 0 || !transcript ? own : recallChunks([...sessionMessages(transcript), { role: "user", content: "" }], kept)
  const withSubagents = transcript ? [...session, ...subagentChunks(transcript)] : session
  const handoffs = result.threadKey ? activeHandoffs(readState(result.threadKey).handoffs) : {}
  return [...handoffChunks(handoffs), ...withSubagents]
}

function recallTarget(original: Body, result: Rewrite): { key: string; text: string } | null {
  const live = livePrompt(original.messages)
  return live && result.threadKey ? { key: messageFingerprint(original.messages[live.index]), text: live.text } : null
}

export function applyRecall(input: RewriteInput, result: Rewrite): Rewrite {
  if (!touched(input, result) || !result.threadKey) return result
  const state = readState(result.threadKey)
  state.recalls ??= {}
  const target = recallTarget(input.body, result)
  let note = result.note
  if (target && !(target.key in state.recalls)) {
    state.recalls[target.key] = recallFor(target.text, droppedChunks(input, result), input.config.eval?.recallOptions) ?? ""
    saveState(result.threadKey, state)
    note = { ...note, recalled: state.recalls[target.key].length }
  }
  const messages = withRecall(result.body.messages, messageFingerprint, activeRecalls(state.recalls))
  return messages === result.body.messages ? { ...result, note } : { ...result, body: { ...result.body, messages }, note }
}

export async function prefetchFor(input: RewriteInput, result: Rewrite, rerank: Reranker): Promise<number | null> {
  if (!touched(input, result) || !result.threadKey) return null
  const target = recallTarget(input.body, result)
  if (!target) return null
  const state = readState(result.threadKey)
  state.recalls ??= {}
  if (target.key in state.recalls) return null
  const options = { candidates: input.config.eval?.rerank?.candidates, ...input.config.eval?.recallOptions }
  state.recalls[target.key] = (await recallForWith(target.text, droppedChunks(input, result), rerank, options)) ?? ""
  saveState(result.threadKey, state)
  return state.recalls[target.key].length
}
