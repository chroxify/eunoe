import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { REPLAY_NATIVE_COMPACT_AT, replaySession } from "../src/cli/replay"
import type { Message } from "../src/context/content"
import { compact } from "../src/proxy/compaction"
import { DEFAULT_RATIO, sizeOf } from "../src/proxy/estimate"
import type { ThreadState } from "../src/proxy/state"
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
    expect(out.dropped).toBe(0)
    expect(out.eunoeCost).toBeLessThan(out.plainCost)
    expect(out.peakEunoe).toBeLessThan(out.peakPlain)
    expect(out.requests).toBe(1 + 60 * 13)
    expect(out.turns).toBe(61)
  })

  test("with room to spare nothing folds and both sides match", () => {
    const out = replaySession(session(5, 100), { config: config(), window: 10_000_000, fixedTokens })
    expect(out.folds).toBe(0)
    expect(out.dropped).toBe(0)
    expect(out.nativeCompactions).toBe(0)
    expect(out.eunoeTokens).toBe(out.plainTokens)
    expect(out.eunoeCost).toBe(out.plainCost)
  })

  test("folded turns that still do not fit are removed entirely, and that is counted as dropped", () => {
    const out = replaySession(session(60, 30_000), { config: config(), window: 12_000, fixedTokens })
    expect(out.dropped).toBeGreaterThan(0)
  })

  test("plain Claude Code compacts once it fills the window, and that is counted", () => {
    const window = 20_000
    const out = replaySession(session(30, 30_000), { config: config(), window, fixedTokens })
    expect(out.nativeCompactions).toBeGreaterThan(0)
    expect(out.peakPlain).toBeGreaterThan(REPLAY_NATIVE_COMPACT_AT * window)
  })
})

function claudeHome(settings: Record<string, unknown> = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "eunoe-replay-home-"))
  const project = path.join(home, ".claude", "projects", "-repo")
  mkdirSync(project, { recursive: true })
  writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(settings))
  return { home, project }
}

function writeSession(project: string, id: string, messages: Message[], lastActive: Date, started = lastActive) {
  const file = path.join(project, `${id}.jsonl`)
  writeFileSync(file, `${messages.map((message) => JSON.stringify({ type: message.role, cwd: "/repo", timestamp: started.toISOString(), message })).join("\n")}\n`)
  utimesSync(file, lastActive, lastActive)
}

function runCli(home: string, ...args: string[]) {
  const eunoeDir = path.join(home, ".eunoe")
  mkdirSync(eunoeDir, { recursive: true })
  const out = Bun.spawnSync(["bun", path.join(import.meta.dir, "..", "src", "cli", "main.ts"), ...args], {
    env: { ...process.env, HOME: home, EUNOE_DIR: eunoeDir, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), NO_COLOR: "1" },
  })
  return out.stdout.toString() + out.stderr.toString()
}

const withoutTimings = (text: string) => text.replace(/ {2}· {2}\d+(m \d+)?s$/m, "")

describe("eunoe replay", () => {
  const first = "11111111-1111-4111-8111-111111111111"
  const second = "22222222-2222-4222-8222-222222222222"
  const broken = "33333333-3333-4333-8333-333333333333"

  test("the same sessions on disk replay to the same numbers every time, whatever order the workers take them in", () => {
    const { home, project } = claudeHome()
    writeSession(project, first, busy(20, 6, 4_000), new Date("2026-09-14T12:00:00Z"))
    writeSession(project, second, session(25, 8_000), new Date("2026-10-13T12:00:00Z"))
    const runs = [runCli(home, "replay"), runCli(home, "replay"), runCli(home, "replay")].map(withoutTimings)
    expect(runs[0]).toContain("2 replayed")
    expect(runs[1]).toBe(runs[0])
    expect(runs[2]).toBe(runs[0])
    const requests = replaySession(busy(20, 6, 4_000), { config: config(), window: 1_000_000, fixedTokens: 30_000 }).requests + replaySession(session(25, 8_000), { config: config(), window: 1_000_000, fixedTokens: 30_000 }).requests
    expect(runs[0]).toMatch(new RegExp(`Requests\\s+${requests.toLocaleString()}\\b`))
  })

  test("the history line runs from the oldest session's start to the latest activity, and says how long Claude Code keeps sessions", () => {
    const { home, project } = claudeHome({ cleanupPeriodDays: 14 })
    writeSession(project, first, session(5, 100), new Date("2026-09-20T12:00:00Z"), new Date("2026-09-14T12:00:00Z"))
    writeSession(project, second, session(5, 100), new Date("2026-10-13T12:00:00Z"))
    const out = runCli(home, "replay")
    expect(out).toMatch(/History\s+Sep 14, 2026 – Oct 13, 2026/)
    expect(out).toContain("idle for 14 days")
  })

  test("a session that cannot be replayed is reported, not silently left out, and the rest still count", () => {
    const { home, project } = claudeHome()
    writeSession(project, first, session(5, 100), new Date())
    mkdirSync(path.join(project, `${broken}.jsonl`))
    const out = runCli(home, "replay")
    expect(out).toContain("1 replayed")
    expect(out).toContain("1 session couldn't be replayed")
    expect(out).toContain("33333333")
  })
})

describe("eunoe status", () => {
  test("the last 24 hours count every logged request, however many there were", () => {
    const { home } = claudeHome()
    mkdirSync(path.join(home, ".eunoe"), { recursive: true })
    const now = Date.now()
    const records = Array.from({ length: 6_200 }, (_, i) => ({
      ts: new Date(now - 3_600_000 + i).toISOString(),
      thread: `s-${i % 3}`,
      input: 1_000,
      cacheRead: 900,
      cacheWrite: 50,
      uncached: 50,
      charsIn: 8_000,
      charsOut: 4_000,
      charsFixed: 1_000,
    }))
    const old = Array.from({ length: 300 }, (_, i) => ({ ts: new Date(now - 3 * 86_400_000 + i).toISOString(), thread: "s-old", input: 1_000, charsIn: 4_000, charsOut: 4_000 }))
    writeFileSync(path.join(home, ".eunoe", "requests.jsonl"), `${[...old, ...records].map((r) => JSON.stringify(r)).join("\n")}\n`)
    const out = runCli(home, "status")
    const last24h = out.slice(out.indexOf("Last 24h"), out.indexOf("All time"))
    expect(last24h).toMatch(/Requests\s+6,200\b/)
    expect(last24h).toContain("6.2M")
    expect(out.slice(out.indexOf("All time"))).toMatch(/Requests\s+6,500\b/)
  })
})
