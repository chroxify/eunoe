import { searchOnlyInstructions, trimInstructions, TRANSCRIPT_FALLBACK } from "../context/prompts"
import { appendSystem, tailMessages, trimMessages } from "../context/strategies"
import { splitTurns, turnFingerprint } from "../context/turns"
import type { Body } from "../context/types"
import { searchGuide } from "../transcript/search"
import { compact } from "./compaction"
import { DEFAULT_RATIO } from "./constants"
import { estimator, targetSize } from "./estimate"
import { loadState, saveState } from "./state"
import type { Rewrite, RewriteInput } from "./types"

const pass = (body: Body): Rewrite => ({ body, threadKey: null, note: { action: "pass" } })

const isAgentThread = (body: Body) => Array.isArray(body.tools) && body.tools.length > 0

export function rewrite(input: RewriteInput): Rewrite {
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
  }

  if (config.mode === "trim") {
    if (!isAgentThread(body)) return pass(body)
    const messages = trimMessages(body.messages)
    return {
      body: { ...body, system: appendSystem(body.system, trimInstructions(guide ?? TRANSCRIPT_FALLBACK)), messages },
      threadKey,
      note: { action: "trim", turns: turns.length, messagesIn: body.messages.length, messagesOut: messages.length },
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
