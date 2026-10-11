import { describe, expect, test } from "bun:test"
import { replaySession } from "../src/cli/replay"
import { REPLAY_NATIVE_COMPACT_AT } from "../src/cli/replay/constants"
import type { Message } from "../src/context/types"
import { compact } from "../src/proxy/compaction"
import { DEFAULT_RATIO } from "../src/proxy/constants"
import { sizeOf } from "../src/proxy/estimate"
import type { ThreadState } from "../src/proxy/types"
import { call, config, reply, result, session, user } from "./fixtures"

const fixedTokens = 2_000

function naive(messages: ReturnType<typeof session>, window: number) {
  const cfg = config()
  const system = "x".repeat(Math.round(fixedTokens / DEFAULT_RATIO))
  const state: ThreadState = {}
  let total = 0
  let folds = 0
  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i].role !== "assistant") continue
    const out = compact({ body: { system, tools: [], messages: messages.slice(0, i) } as any, config: cfg, state, window, guide: null, mayCompact: true })
    if (out.note.compacted) folds += 1
    total += Math.round((sizeOf({ system, tools: [], messages: out.messages }) - sizeOf({ system, tools: [], messages: [] })) * DEFAULT_RATIO)
  }
  return { total, folds }
}

function busy(turns: number, calls: number, output: number): Message[] {
  const messages: Message[] = [user("first"), reply("ok")]
  for (let t = 1; t <= turns; t += 1) {
    messages.push(user(`task ${t}`))
    for (let k = 1; k <= calls; k += 1) messages.push(call(`c${t}-${k}`), result(`c${t}-${k}`, output))
    messages.push(reply(`answer ${t}`))
  }
  return messages
}

describe("replay", () => {
  test("the incremental replay sends what running eunoe on every request would send", () => {
    const messages = session(30, 30_000)
    const window = 60_000
    const fast = replaySession(messages, { config: config(), window, fixedTokens, recallChars: 0 })
    const slow = naive(messages, window)
    expect(fast.folds).toBe(slow.folds)
    expect(fast.folds).toBeGreaterThan(0)
    expect(Math.abs(fast.eunoeTokens - slow.total) / slow.total).toBeLessThan(0.01)
  })

  test("a session that works in many requests per turn sends fewer tokens and costs less once folded", () => {
    const out = replaySession(busy(60, 12, 8_000), { config: config(), window: 1_000_000, fixedTokens })
    expect(out.folds).toBeGreaterThan(0)
    expect(out.eunoeTokens).toBeLessThan(out.plainTokens)
    expect(out.eunoeCost).toBeLessThan(out.plainCost)
    expect(out.peakEunoe).toBeLessThan(out.peakPlain)
    expect(out.requests).toBe(1 + 60 * 13)
    expect(out.turns).toBe(61)
  })

  test("with room to spare nothing folds and both sides match", () => {
    const out = replaySession(session(5, 100), { config: config(), window: 10_000_000, fixedTokens })
    expect(out.folds).toBe(0)
    expect(out.nativeCompactions).toBe(0)
    expect(out.eunoeTokens).toBe(out.plainTokens)
    expect(out.eunoeCost).toBe(out.plainCost)
  })

  test("plain Claude Code compacts once it fills the window, and that is counted", () => {
    const window = 20_000
    const out = replaySession(session(30, 30_000), { config: config(), window, fixedTokens })
    expect(out.nativeCompactions).toBeGreaterThan(0)
    expect(out.peakPlain).toBeGreaterThan(REPLAY_NATIVE_COMPACT_AT * window)
  })
})
