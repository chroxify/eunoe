import type { Message } from "../context/content"
import { splitTurns, turnFingerprint } from "../context/fold/turns"
import { threadKeyOf } from "./rewrite"
import { resetCut, type ThreadState, type ThreadStore } from "./state"

export interface FoldTarget {
  store: ThreadStore
  threadId: string
  messages: Message[]
}

export interface FoldOptions {
  at?: number | "latest"
  pin?: number[]
}

export interface Folded {
  threadKey: string
  cutTurn: number | null
  pinned: number[]
}

function located({ store, threadId, messages }: FoldTarget) {
  const threadKey = threadKeyOf(threadId, messages)
  if (!threadKey) throw new RangeError("eunoe can only fold a thread that has at least one user turn")
  return { threadKey, turns: splitTurns(messages).turns, state: store.read(threadKey) }
}

function checkedTurn(turn: number, turns: Message[][], from: number): number {
  if (turns.length <= from) throw new RangeError(`this thread has ${turns.length} turn${turns.length === 1 ? "" : "s"}, so there is no turn ${turn} to fold at`)
  if (!Number.isInteger(turn) || turn < from || turn >= turns.length) throw new RangeError(`turn ${turn} is outside turns ${from}..${turns.length - 1}`)
  return turn
}

function folded(threadKey: string, turns: Message[][], state: ThreadState): Folded {
  const cutTurn = state.cut ? turns.findIndex((turn) => turnFingerprint(turn) === state.cut) : -1
  const pins = new Set(state.pins)
  return { threadKey, cutTurn: cutTurn > 0 ? cutTurn : null, pinned: turns.flatMap((turn, i) => (pins.has(turnFingerprint(turn)) ? [i] : [])) }
}

function withPins(state: ThreadState, turns: Message[][], indices: number[], pinned: boolean) {
  const pins = new Set(state.pins)
  for (const index of indices) {
    const fingerprint = turnFingerprint(turns[checkedTurn(index, turns, 0)])
    if (pinned) pins.add(fingerprint)
    else pins.delete(fingerprint)
  }
  if (pins.size > 0) state.pins = [...pins].sort()
  else delete state.pins
}

export function foldThread(target: FoldTarget, { at = "latest", pin = [] }: FoldOptions = {}): Folded {
  const { threadKey, turns, state } = located(target)
  const cut = checkedTurn(at === "latest" ? turns.length - 1 : at, turns, 1)
  withPins(state, turns, pin, true)
  resetCut(state)
  state.cut = turnFingerprint(turns[cut])
  state.keep = cut - 1
  state.host = true
  target.store.save(threadKey, state)
  return folded(threadKey, turns, state)
}

export function pinTurns(target: FoldTarget, indices: number[], pinned = true): Folded {
  const { threadKey, turns, state } = located(target)
  withPins(state, turns, indices, pinned)
  target.store.save(threadKey, state)
  return folded(threadKey, turns, state)
}
