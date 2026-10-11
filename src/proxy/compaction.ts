import type { Config } from "../config"
import type { Body, Message } from "../context/content"
import { type CompactOptions, capTurns, clearToolResults, compactMessages, countToolResults } from "../context/fold/strategies"
import { splitTurns, turnFingerprint } from "../context/fold/turns"
import { clearedOutput } from "../context/prompts"
import { DEFAULT_RATIO, type Estimator, estimator, targetSize } from "./estimate"
import { resetCut, type ThreadState } from "./state"

export interface CompactInput {
  body: Body
  config: Config
  state: ThreadState
  window: number | null
  guide: string | null
  transcriptDir?: string | null
  mayCompact: boolean
  omittedBefore?: number
  decorate?: (messages: Message[]) => Message[]
  reduce?: CompactOptions["reduce"]
}

export interface CompactResult {
  messages: Message[]
  stateChanged: boolean
  note: Record<string, unknown>
}

interface Rolling {
  keep: number
  budget: number
}

const PROTECTED_OUTPUTS = 5

function settledCut(turns: Message[][], index: number) {
  let cut = index
  while (cut > 1 && JSON.stringify(turns[cut][0].content).includes("[Request interrupted")) cut -= 1
  return cut
}

function resolveCut(turns: Message[][], state: ThreadState, config: Config, rollingKeep: number | undefined) {
  let cutIndex = state.cut ? turns.findIndex((turn) => turnFingerprint(turn) === state.cut) : -1
  let stateChanged = false
  if (state.cut && cutIndex === -1) {
    resetCut(state)
    stateChanged = true
  }
  if (cutIndex <= 0 && config.eval?.forceCut && turns.length >= 3) {
    cutIndex = settledCut(turns, Math.max(1, turns.length - 1 - (rollingKeep ?? 1)))
    state.cut = turnFingerprint(turns[cutIndex])
    stateChanged = true
  }
  return { cutIndex, stateChanged }
}

function shrinkOnce(state: ThreadState, cutIndex: number, configuredKeep: number, liveResults: () => number): string {
  const keep = Math.min(state.keep ?? configuredKeep, cutIndex - 1)
  if (cutIndex > 0 && keep > 0) {
    state.keep = keep - 1
    return `keep=${state.keep}`
  }
  const remaining = liveResults() - (state.cleared ?? 0) - PROTECTED_OUTPUTS
  if (remaining <= 0) return "stuck"
  state.cleared = (state.cleared ?? 0) + Math.ceil(remaining / 2)
  return `cleared=${state.cleared}`
}

function dueRoll(turns: Message[][], cutIndex: number, rolling: Rolling, size: Estimator): number | null {
  const next = settledCut(turns, turns.length - 1 - rolling.keep)
  const backlog = size.of(turns.slice(Math.max(cutIndex, 0), Math.max(next, 0)).flat()) - size.fixed
  return next >= 1 && next > cutIndex && backlog > rolling.budget ? next : null
}

function shrinkToTarget(over: () => boolean, step: () => string, actions: string[], rebuild: () => void) {
  while (over()) {
    const action = step()
    actions.push(action)
    if (action === "stuck") return
    rebuild()
  }
}

export function compact({ body, config, state, window, guide, transcriptDir, mayCompact, omittedBefore = 0, decorate = (m) => m, reduce }: CompactInput): CompactResult {
  const { turns } = splitTurns(body.messages)
  const rolling = config.eval?.rolling ?? (config.mode === "default" ? { keep: config.keep, budget: config.budget } : undefined)
  const resolved = resolveCut(turns, state, config, rolling?.keep)
  let cutIndex = resolved.cutIndex
  let stateChanged = resolved.stateChanged

  const configuredKeep = config.keepTurns === "all" ? Number.MAX_SAFE_INTEGER : config.keepTurns
  const ratio = state.ratio ?? DEFAULT_RATIO
  const options = { guide, omittedBefore, evidence: config.eval?.evidence ?? true, reduce, capChars: config.turnCap === "off" ? undefined : config.turnCap / ratio }
  const liveStart = (list: Message[]) =>
    list.length -
    splitTurns(list)
      .turns.slice(-(turns.length - Math.max(cutIndex, 0)))
      .flat().length
  const compacted = () => capTurns(cutIndex > 0 ? compactMessages(body.messages, cutIndex, { ...options, keepTurns: state.keep ?? configuredKeep }) : body.messages, { ...options, keepTurns: 0 })
  const build = () => {
    const messages = compacted()
    return state.cleared ? clearToolResults(messages, liveStart(messages), state.cleared, clearedOutput(transcriptDir ?? null)) : messages
  }
  const liveResults = () => {
    const uncleared = compacted()
    return countToolResults(uncleared, liveStart(uncleared))
  }

  const size = estimator(body, ratio)
  const limit = window ? config.compactAt * window : Number.POSITIVE_INFINITY
  const target = window ? targetSize(size, window) : Number.POSITIVE_INFINITY

  let messages = build()
  let estimate = size.of(decorate(messages))
  const actions: string[] = []
  const rebuild = () => {
    messages = build()
    estimate = size.of(decorate(messages))
  }
  const moveCut = (index: number, action: string) => {
    cutIndex = index
    resetCut(state)
    state.cut = turnFingerprint(turns[index])
    actions.push(action)
    rebuild()
  }

  const roll = mayCompact && rolling ? dueRoll(turns, cutIndex, rolling, size) : null
  if (roll !== null) {
    moveCut(roll, "roll")
    stateChanged = true
  }

  if (mayCompact && estimate > limit) {
    const current = turns.length - 1
    if (current > 0 && current > cutIndex) moveCut(current, "cut")
    shrinkToTarget(
      () => estimate > target,
      () => shrinkOnce(state, cutIndex, configuredKeep, liveResults),
      actions,
      rebuild,
    )
    stateChanged = true
  }

  return {
    messages,
    stateChanged,
    note: {
      action: cutIndex > 0 ? "compact" : "full",
      compacted: actions.includes("cut") || actions.includes("roll"),
      actions: actions.length > 0 ? actions : undefined,
      cutTurn: cutIndex > 0 ? cutIndex : null,
      omitted: cutIndex > 0 ? Math.max(1, cutIndex - (state.keep ?? configuredKeep)) - 1 : 0,
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
