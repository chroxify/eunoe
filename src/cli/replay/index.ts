import { isPrompt, reduceTurn, splitTurns, turnFingerprint } from "../../context/fold/turns"
import type { ReduceOptions } from "../../context/fold/types"
import type { Body, Message } from "../../context/types"
import { compact } from "../../proxy/compaction"
import { DEFAULT_RATIO } from "../../proxy/constants"
import { sizeOf } from "../../proxy/estimate"
import type { ThreadState } from "../../proxy/types"
import { REPLAY_CACHE_READ_WEIGHT, REPLAY_CACHE_WRITE_WEIGHT, REPLAY_NATIVE_COMPACT_AT, REPLAY_NATIVE_SUMMARY_CHARS, REPLAY_RECALL_CHARS } from "./constants"
import type { Replay, ReplayOptions } from "./types"

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

export function replaySession(messages: Message[], { config, window, fixedTokens, recallChars: recallPerPrompt = REPLAY_RECALL_CHARS }: ReplayOptions): Replay {
  const out: Replay = { requests: 0, turns: 0, folds: 0, nativeCompactions: 0, discarded: 0, plainTokens: 0, eunoeTokens: 0, plainCost: 0, eunoeCost: 0, peakPlain: 0, peakEunoe: 0 }
  const fixedChars = Math.round(fixedTokens / DEFAULT_RATIO)
  const system = "x".repeat(fixedChars)
  const body = (ms: Message[]) => ({ system, tools: [], messages: ms }) as Body
  const sizes = messages.map(charsOf)
  const { preamble, turns } = splitTurns(messages)
  out.turns = turns.length
  const turnAt: number[] = messages.map(() => -1)
  let at = preamble.length
  for (const [k, turn] of turns.entries()) {
    for (const _ of turn) {
      turnAt[at] = k
      at += 1
    }
  }

  const reduced = new Map<string, Message[]>()
  const reduce = (turn: Message[], options: ReduceOptions) => {
    const key = `${turnFingerprint(turn)}:${turn.length}`
    const hit = reduced.get(key) ?? reduceTurn(turn, options)
    reduced.set(key, hit)
    return hit
  }

  const state: ThreadState = {}
  let sent: Message[] = []
  let sentSum = 0
  let sentCount = 0
  let sentUpTo = 0
  let recallChars = 0
  let compactedTurn = -2
  let prevEunoe = 0
  let prevPlain = 0
  let plainSum = 0
  let plainCount = 0
  let plainSince = 0
  const limit = (config.compactAt * window) / DEFAULT_RATIO

  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i].role !== "assistant") continue
    out.requests += 1
    const turn = turnAt[i - 1]
    const newTurn = turn !== compactedTurn
    if (newTurn && state.cut && isPrompt(messages[i - 1])) recallChars += recallPerPrompt
    for (let k = sentUpTo; k < i; k += 1) {
      sentSum += sizes[k]
      sentCount += 1
    }
    sentUpTo = i
    let eunoeCacheable = prevEunoe
    if (newTurn || fixedChars + listChars(sentSum, sentCount) + recallChars > limit) {
      const prefix = messages.slice(0, i)
      const result = compact({ body: body(prefix), config, state, window, guide: null, mayCompact: true, reduce, decorate: (ms) => (recallChars ? [...ms, { role: "user", content: "r".repeat(recallChars) }] : ms) })
      const changed = Boolean(result.note.compacted) || Boolean(result.note.actions)
      if (result.note.compacted) out.folds += 1
      if (changed) eunoeCacheable = Math.min(prevEunoe, fixedChars + commonPrefix(sent, result.messages))
      sent = result.messages
      sentSum = sent.reduce((sum, m) => sum + charsOf(m), 0)
      sentCount = sent.length
      compactedTurn = turn
    }
    const eunoe = fixedChars + listChars(sentSum, sentCount) + recallChars
    out.eunoeTokens += tokens(eunoe - fixedChars)
    out.peakEunoe = Math.max(out.peakEunoe, tokens(eunoe))
    const eunoeCached = Math.max(0, eunoeCacheable - fixedChars)
    out.eunoeCost += REPLAY_CACHE_READ_WEIGHT * tokens(eunoeCached) + REPLAY_CACHE_WRITE_WEIGHT * tokens(eunoe - fixedChars - eunoeCached)
    prevEunoe = eunoe

    for (let k = plainSince; k < i; k += 1) {
      plainSum += sizes[k]
      plainCount += 1
    }
    plainSince = i
    let plain = fixedChars + listChars(plainSum, plainCount)
    let plainCacheable = prevPlain
    out.peakPlain = Math.max(out.peakPlain, tokens(plain))
    if (tokens(plain) > REPLAY_NATIVE_COMPACT_AT * window) {
      out.nativeCompactions += 1
      out.discarded += tokens(plain - fixedChars)
      plainSum = REPLAY_NATIVE_SUMMARY_CHARS
      plainCount = 1
      plain = fixedChars + listChars(plainSum, plainCount)
      plainCacheable = fixedChars
    }
    out.plainTokens += tokens(plain - fixedChars)
    const plainCached = Math.max(0, plainCacheable - fixedChars)
    out.plainCost += REPLAY_CACHE_READ_WEIGHT * tokens(plainCached) + REPLAY_CACHE_WRITE_WEIGHT * tokens(plain - fixedChars - plainCached)
    prevPlain = plain
  }
  return out
}
