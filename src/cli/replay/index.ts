import type { Config } from "../../config"
import type { Body, Message } from "../../context/content"
import { isPrompt, type ReduceOptions, reduceTurn, splitTurns, turnFingerprint } from "../../context/fold/turns"
import { compact } from "../../proxy/compaction"
import { DEFAULT_RATIO, sizeOf } from "../../proxy/estimate"
import type { ThreadState } from "../../proxy/state"

export interface ReplayOptions {
  config: Config
  window: number
  fixedTokens: number
  recallChars?: number
}

export interface Replay {
  requests: number
  turns: number
  folds: number
  dropped: number
  nativeCompactions: number
  discarded: number
  plainTokens: number
  eunoeTokens: number
  plainCost: number
  eunoeCost: number
  peakPlain: number
  peakEunoe: number
}

export interface ReplayedSession extends Replay {
  id: string
  file: string
  bytes: number
  cwd: string | null
  title: string | null
  ms: number
}

export interface ReplayFailure {
  file: string
  error: string
}

export const REPLAY_NATIVE_COMPACT_AT = 0.92

export const NATIVE_SUMMARY_CHARS = 30_000
const CACHE_READ_WEIGHT = 0.1
const CACHE_WRITE_WEIGHT = 1.25

const emptyChars = sizeOf({ system: "", tools: [], messages: [] })
const charsOf = (message: Message) => sizeOf({ system: "", tools: [], messages: [message] }) - emptyChars
const listChars = (sum: number, count: number) => sum + Math.max(0, count - 1)
const tokens = (chars: number) => Math.round(chars * DEFAULT_RATIO)

function commonPrefix(a: Message[], b: Message[]): number {
  let chars = 0
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i] && JSON.stringify(a[i]) !== JSON.stringify(b[i])) break
    chars += charsOf(a[i]) + 1
  }
  return chars
}

export function replaySession(messages: Message[], { config, window, fixedTokens, recallChars: recallPerPrompt = 3_500 }: ReplayOptions): Replay {
  const out: Replay = { requests: 0, turns: 0, folds: 0, dropped: 0, nativeCompactions: 0, discarded: 0, plainTokens: 0, eunoeTokens: 0, plainCost: 0, eunoeCost: 0, peakPlain: 0, peakEunoe: 0 }
  const fixedChars = Math.round(fixedTokens / DEFAULT_RATIO)
  const system = "x".repeat(fixedChars)
  const sizes = messages.map(charsOf)
  const { preamble, turns } = splitTurns(messages)
  const turnAt = [...preamble.map(() => -1), ...turns.flatMap((turn, k) => turn.map(() => k))]
  const limit = (config.compactAt * window) / DEFAULT_RATIO
  const cost = (chars: number, cacheable: number) => {
    const cached = Math.max(0, cacheable - fixedChars)
    return CACHE_READ_WEIGHT * tokens(cached) + CACHE_WRITE_WEIGHT * tokens(chars - fixedChars - cached)
  }
  out.turns = turns.length

  const reduced = new Map<string, Message[]>()
  const reduce = (turn: Message[], options: ReduceOptions) => {
    const key = `${turnFingerprint(turn)}:${turn.length}`
    const hit = reduced.get(key) ?? reduceTurn(turn, options)
    reduced.set(key, hit)
    return hit
  }

  const state: ThreadState = {}
  const eunoe = { sent: [] as Message[], sum: 0, count: 0, upTo: 0, recall: 0, compactedTurn: -2, previous: 0 }
  const plain = { sum: 0, count: 0, since: 0, previous: 0, whole: 0, wholeCount: 0 }

  const sendEunoe = (i: number) => {
    const turn = turnAt[i - 1]
    const newTurn = turn !== eunoe.compactedTurn
    if (newTurn && state.cut && isPrompt(messages[i - 1])) eunoe.recall += recallPerPrompt
    for (; eunoe.upTo < i; eunoe.upTo += 1) {
      eunoe.sum += sizes[eunoe.upTo]
      eunoe.count += 1
    }
    let cacheable = eunoe.previous
    if (newTurn || fixedChars + listChars(eunoe.sum, eunoe.count) + eunoe.recall > limit) {
      const recall = eunoe.recall
      const decorate = (ms: Message[]) => (recall ? [...ms, { role: "user", content: "r".repeat(recall) }] : ms)
      const result = compact({ body: { system, tools: [], messages: messages.slice(0, i) } as Body, config, state, window, guide: null, mayCompact: true, reduce, decorate })
      if (result.note.compacted) out.folds += 1
      out.dropped = Math.max(out.dropped, Number(result.note.omitted ?? 0))
      if (result.note.compacted || result.note.actions) cacheable = Math.min(eunoe.previous, fixedChars + commonPrefix(eunoe.sent, result.messages))
      eunoe.sent = result.messages
      eunoe.sum = eunoe.sent.reduce((sum, m) => sum + charsOf(m), 0)
      eunoe.count = eunoe.sent.length
      eunoe.compactedTurn = turn
    }
    const chars = fixedChars + listChars(eunoe.sum, eunoe.count) + eunoe.recall
    out.eunoeTokens += tokens(chars - fixedChars)
    out.peakEunoe = Math.max(out.peakEunoe, tokens(chars))
    out.eunoeCost += cost(chars, cacheable)
    eunoe.previous = chars
  }

  const sendPlain = (i: number) => {
    for (; plain.since < i; plain.since += 1) {
      plain.sum += sizes[plain.since]
      plain.count += 1
      plain.whole += sizes[plain.since]
      plain.wholeCount += 1
    }
    out.peakPlain = Math.max(out.peakPlain, tokens(fixedChars + listChars(plain.whole, plain.wholeCount)))
    let chars = fixedChars + listChars(plain.sum, plain.count)
    let cacheable = plain.previous
    if (tokens(chars) > REPLAY_NATIVE_COMPACT_AT * window) {
      out.nativeCompactions += 1
      out.discarded += tokens(chars - fixedChars)
      plain.sum = NATIVE_SUMMARY_CHARS
      plain.count = 1
      chars = fixedChars + listChars(plain.sum, plain.count)
      cacheable = fixedChars
    }
    out.plainTokens += tokens(chars - fixedChars)
    out.plainCost += cost(chars, cacheable)
    plain.previous = chars
  }

  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i].role !== "assistant") continue
    out.requests += 1
    sendEunoe(i)
    sendPlain(i)
  }
  return out
}
