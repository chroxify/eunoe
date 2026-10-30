import { type Body, type Message, quickHash } from "../context/content"
import { type CompactOptions, capTurns, clearToolResults, compactMessages, countToolResults } from "../context/fold/strategies"
import { type ReduceOptions, reduceTurn, splitTurns, turnFingerprint } from "../context/fold/turns"
import { clearedOutput } from "../context/prompts"
import type { CoreConfig } from "./config"
import { DEFAULT_RATIO, type Estimator, estimator, targetSize } from "./estimate"
import type { RewriteNote } from "./rewrite"
import { resetCut, type ThreadState } from "./state"

export interface CompactInput {
  body: Body
  config: CoreConfig
  state: ThreadState
  window: number | null
  guide: string | null
  transcriptDir?: string | null
  mayCompact: boolean
  omittedBefore?: number
  decorate?: (messages: Message[]) => Message[]
  reduce?: CompactOptions["reduce"]
}

const FOLDED_TURNS = 4096

const folded = new Map<string, Message[]>()

function reduceRemembered(turn: Message[], options: ReduceOptions): Message[] {
  const key = `${options.evidence ? 1 : 0}:${quickHash(JSON.stringify(turn))}`
  const known = folded.get(key)
  if (known) {
    folded.delete(key)
    folded.set(key, known)
    return known
  }
  const reduced = reduceTurn(turn, options)
  folded.set(key, reduced)
  if (folded.size > FOLDED_TURNS) folded.delete(folded.keys().next().value as string)
  return reduced
}

export interface CompactResult {
  messages: Message[]
  stateChanged: boolean
  note: RewriteNote
}

interface Rolling {
  keep: number
  budget: number
}

const PROTECTED_OUTPUTS = 5

const STUCK_STEP = 0.1

function settledCut(turns: Message[][], index: number) {
  let cut = index
  while (cut > 1 && JSON.stringify(turns[cut][0].content).includes("[Request interrupted")) cut -= 1
  return cut
}

function resolveCut(turns: Message[][], state: ThreadState, config: CoreConfig, rollingKeep: number | undefined) {
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

function shrinkToTarget(over: () => boolean, step: () => string, actions: string[], rebuild: () => void): boolean {
  while (over()) {
    const action = step()
    actions.push(action)
    if (action === "stuck") return true
    rebuild()
  }
  return false
}

const holdsStuck = (state: ThreadState, estimate: number, window: number | null) => window !== null && state.stuck !== undefined && estimate <= state.stuck + STUCK_STEP * window

export type StuckSizes = ReturnType<typeof stuckSizes>

function stuckSizes(messages: Message[], headEnd: number, liveFrom: number, size: Estimator) {
  const of = (list: Message[]) => size.of(list) - size.fixed
  return { fixed: size.fixed, head: of(messages.slice(0, headEnd)), folded: of(messages.slice(headEnd, liveFrom)), live: of(messages.slice(liveFrom)) }
}

function cutNote(state: ThreadState, cutIndex: number, configuredKeep: number, actions: string[]) {
  const omitted = cutIndex > 0 ? Math.max(1, cutIndex - (state.keep ?? configuredKeep)) - 1 : 0
  return {
    action: cutIndex > 0 ? ("compact" as const) : ("full" as const),
    compacted: actions.includes("cut") || actions.includes("roll"),
    actions: actions.length > 0 ? actions : undefined,
    cutTurn: cutIndex > 0 ? cutIndex : null,
    omitted,
    folded: cutIndex > 0 ? cutIndex - 1 - omitted : 0,
    keep: state.keep,
    cleared: state.cleared,
  }
}

export function compact({ body, config, state, window, guide, transcriptDir, mayCompact, omittedBefore = 0, decorate = (m) => m, reduce }: CompactInput): CompactResult {
  const { preamble, turns } = splitTurns(body.messages)
  const rolling = config.eval?.rolling ?? (config.mode === "default" ? { keep: config.keep, budget: config.budget } : undefined)
  const resolved = resolveCut(turns, state, config, rolling?.keep)
  let cutIndex = resolved.cutIndex
  let stateChanged = resolved.stateChanged

  const configuredKeep = config.keepTurns === "all" ? Number.MAX_SAFE_INTEGER : config.keepTurns
  const ratio = state.ratio ?? DEFAULT_RATIO
  const options = { guide, omittedBefore, evidence: config.eval?.evidence ?? true, reduce: reduce ?? reduceRemembered, capChars: config.turnCap === "off" ? undefined : config.turnCap / ratio }
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
    if (!holdsStuck(state, estimate, window)) {
      const stuck = shrinkToTarget(
        () => estimate > target,
        () => shrinkOnce(state, cutIndex, configuredKeep, liveResults),
        actions,
        rebuild,
      )
      if (stuck) state.stuck = estimate
      else delete state.stuck
    }
    stateChanged = true
  }

  return {
    messages,
    stateChanged,
    note: {
      ...cutNote(state, cutIndex, configuredKeep, actions),
      stuck: state.stuck === undefined ? undefined : stuckSizes(messages, preamble.length + 2, liveStart(messages), size),
      turns: turns.length,
      messagesIn: body.messages.length,
      messagesOut: messages.length,
      estimate,
      window,
    },
  }
}
