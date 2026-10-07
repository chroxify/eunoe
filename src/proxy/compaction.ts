import { CLEARED_OUTPUT } from "../context/prompts"
import { clearToolResults, compactMessages, countToolResults } from "../context/strategies"
import { splitTurns, turnFingerprint } from "../context/turns"
import { DEFAULT_RATIO, PROTECTED_OUTPUTS } from "./constants"
import { estimator, targetSize } from "./estimate"
import { resetCut } from "./state"
import type { CompactInput, CompactResult } from "./types"

export function compact({ body, config, state, window, guide, mayCompact, omittedBefore = 0 }: CompactInput): CompactResult {
  const { turns } = splitTurns(body.messages)
  let stateChanged = false

  let cutIndex = state.cut ? turns.findIndex((turn) => turnFingerprint(turn) === state.cut) : -1
  if (state.cut && cutIndex === -1) {
    resetCut(state)
    stateChanged = true
  }
  if (cutIndex <= 0 && config.eval?.forceCut && turns.length >= 3) {
    let forced = turns.length - 2
    while (forced > 1 && JSON.stringify(turns[forced][0].content).includes("[Request interrupted")) forced -= 1
    cutIndex = forced
    state.cut = turnFingerprint(turns[forced])
    stateChanged = true
  }

  const configuredKeep = config.keepTurns === "all" ? Number.MAX_SAFE_INTEGER : config.keepTurns
  const liveLength = () => turns.slice(Math.max(cutIndex, 0)).flat().length
  const compacted = () => cutIndex > 0
    ? compactMessages(body.messages, cutIndex, { keepTurns: state.keep ?? configuredKeep, guide, omittedBefore })
    : body.messages
  const build = () => {
    const messages = compacted()
    return state.cleared ? clearToolResults(messages, messages.length - liveLength(), state.cleared, CLEARED_OUTPUT) : messages
  }

  const size = estimator(body, state.ratio ?? DEFAULT_RATIO)
  const limit = window ? config.compactAt * window : Number.POSITIVE_INFINITY
  const target = window ? targetSize(size, window) : Number.POSITIVE_INFINITY

  let messages = build()
  let estimate = size.of(messages)
  const actions: string[] = []
  const current = turns.length - 1

  if (mayCompact && estimate > limit) {
    if (current > 0 && current > cutIndex) {
      cutIndex = current
      resetCut(state)
      state.cut = turnFingerprint(turns[current])
      actions.push("cut")
      messages = build()
      estimate = size.of(messages)
    }
    while (estimate > target) {
      const keep = Math.min(state.keep ?? configuredKeep, cutIndex - 1)
      if (cutIndex > 0 && keep > 0) {
        state.keep = keep - 1
        actions.push(`keep=${state.keep}`)
      } else {
        const unclearedLive = compacted()
        const total = countToolResults(unclearedLive, unclearedLive.length - liveLength())
        const remaining = total - (state.cleared ?? 0) - PROTECTED_OUTPUTS
        if (remaining <= 0) {
          actions.push("stuck")
          break
        }
        state.cleared = (state.cleared ?? 0) + Math.ceil(remaining / 2)
        actions.push(`cleared=${state.cleared}`)
      }
      messages = build()
      estimate = size.of(messages)
    }
    stateChanged = true
  }

  return {
    messages,
    stateChanged,
    note: {
      action: cutIndex > 0 ? "compact" : "full",
      compacted: actions.includes("cut"),
      actions: actions.length ? actions : undefined,
      cutTurn: cutIndex > 0 ? cutIndex : null,
      keep: state.keep,
      cleared: state.cleared,
      turns: turns.length,
      messagesIn: body.messages.length,
      messagesOut: messages.length,
      estimate,
      window,
    },
  }
}
