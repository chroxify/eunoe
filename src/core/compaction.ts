import { type Body, type Message, quickHash } from "../context/content"
import { type CompactOptions, capTurns, clearToolResults, compactMessages, countPinned, countToolResults, foldsOpening } from "../context/fold/strategies"
import { type ReduceOptions, reduceTurn, splitTurns, turnKeys } from "../context/fold/turns"
import { clearedOutput } from "../context/prompts"
import type { CoreConfig } from "./config"
import { DEFAULT_RATIO, type Estimator, estimator, targetSize } from "./estimate"
import type { RewriteNote } from "./rewrite"
import { resetCut, retireRecalls, type ThreadState } from "./state"

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

function settledCut(turns: Message[][], index: number) {
  let cut = index
  while (cut > 1 && JSON.stringify(turns[cut][0].content).includes("[Request interrupted")) cut -= 1
  return cut
}

function resolveCut(turns: Message[][], keys: string[], state: ThreadState, config: CoreConfig, rollingKeep: number | undefined) {
  let cutIndex = state.cut ? keys.indexOf(state.cut) : -1
  let stateChanged = false
  if (state.cut && cutIndex === -1) {
    resetCut(state)
    stateChanged = true
  }
  if (cutIndex <= 0 && config.eval?.forceCut && turns.length >= 3) {
    cutIndex = settledCut(turns, Math.max(1, turns.length - 1 - (rollingKeep ?? 1)))
    state.cut = keys[cutIndex]
    retireRecalls(state, turns.slice(0, cutIndex))
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

interface Shrink {
  estimate: () => number
  step: () => string
  rebuild: () => void
  target: number
  limit: number
  window: number | null
}

function shrinkOrHold(state: ThreadState, actions: string[], shrink: Shrink) {
  const overWindow = (tokens: number) => shrink.window !== null && tokens > shrink.window
  const held = state.stuck === undefined ? null : { keep: state.keep, cleared: state.cleared, actions: actions.length, overWindow: overWindow(shrink.estimate()) }
  shrinkToTarget(() => shrink.estimate() > shrink.target, shrink.step, actions, shrink.rebuild)
  const helped = (estimate: number) => estimate <= shrink.limit || (held?.overWindow === true && !overWindow(estimate))
  if (held && !helped(shrink.estimate())) {
    restoreShrink(state, held)
    actions.length = held.actions
    shrink.rebuild()
  }
  if (shrink.estimate() > shrink.limit) state.stuck = shrink.estimate()
  else {
    delete state.stuck
    if (actions.at(-1) === "stuck") actions.pop()
  }
}

function restoreShrink(state: ThreadState, held: Pick<ThreadState, "keep" | "cleared">) {
  if (held.keep === undefined) delete state.keep
  else state.keep = held.keep
  if (held.cleared === undefined) delete state.cleared
  else state.cleared = held.cleared
}

export type StuckSizes = ReturnType<typeof stuckSizes>

const headLength = (preamble: Message[], first: Message[], firstKey: string, state: ThreadState) => preamble.length + 1 + (countPinned([firstKey], new Set(state.pins)) > 0 ? first.length : 1)

function stuckSizes(messages: Message[], headEnd: number, liveFrom: number, size: Estimator) {
  const of = (list: Message[]) => size.of(list) - size.fixed
  return { fixed: size.fixed, head: of(messages.slice(0, headEnd)), folded: of(messages.slice(headEnd, liveFrom)), live: of(messages.slice(liveFrom)) }
}

function cutNote(state: ThreadState, turns: Message[][], keys: string[], cutIndex: number, configuredKeep: number, actions: string[]) {
  const pins = new Set(state.pins)
  const keptFrom = cutIndex > 0 ? Math.max(1, cutIndex - (state.keep ?? configuredKeep)) : 0
  const omitted = cutIndex > 0 ? keptFrom - 1 - countPinned(keys.slice(1, keptFrom), pins) : 0
  return {
    action: cutIndex > 0 ? ("compact" as const) : ("full" as const),
    compacted: actions.includes("cut") || actions.includes("roll"),
    actions: actions.length > 0 ? actions : undefined,
    cutTurn: cutIndex > 0 ? cutIndex : null,
    omitted,
    folded: cutIndex > 0 ? cutIndex - keptFrom - countPinned(keys.slice(keptFrom, cutIndex), pins) + (foldsOpening(turns[0], keptFrom) && countPinned([keys[0]], pins) === 0 ? 1 : 0) : 0,
    pinned: cutIndex > 0 ? countPinned(keys.slice(0, cutIndex), pins) : 0,
    host: state.host,
    keep: state.keep,
    cleared: state.cleared,
  }
}

export function compact({ body, config, state, window, guide, transcriptDir, mayCompact, omittedBefore = 0, decorate = (m) => m, reduce }: CompactInput): CompactResult {
  const { preamble, turns } = splitTurns(body.messages)
  const rolling = config.eval?.rolling ?? (config.mode === "default" ? { keep: config.keep, budget: config.budget } : undefined)
  const keys = turnKeys(turns)
  const resolved = resolveCut(turns, keys, state, config, rolling?.keep)
  let cutIndex = resolved.cutIndex
  let stateChanged = resolved.stateChanged

  const configuredKeep = config.keepTurns === "all" ? Number.MAX_SAFE_INTEGER : config.keepTurns
  const ratio = state.ratio ?? DEFAULT_RATIO
  const options = { guide, omittedBefore, evidence: config.eval?.evidence ?? true, reduce: reduce ?? reduceRemembered, capChars: config.turnCap === "off" ? undefined : config.turnCap / ratio, pinned: new Set(state.pins) }
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
    state.cut = keys[index]
    retireRecalls(state, turns.slice(0, index))
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
    shrinkOrHold(state, actions, { estimate: () => estimate, step: () => shrinkOnce(state, cutIndex, configuredKeep, liveResults), rebuild, target, limit, window })
    stateChanged = true
  } else if (state.stuck !== undefined) {
    delete state.stuck
    stateChanged = true
  }

  return {
    messages,
    stateChanged,
    note: {
      ...cutNote(state, turns, keys, cutIndex, configuredKeep, actions),
      stuck: state.stuck === undefined ? undefined : stuckSizes(messages, headLength(preamble, turns[0], keys[0], state), liveStart(messages), size),
      turns: turns.length,
      messagesIn: body.messages.length,
      messagesOut: messages.length,
      estimate,
      window,
    },
  }
}
