import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buckets, costSaved, matchLogged, savings, summarize } from "../src/cli/commands/stats"
import { nativeCompactions, threadPeaks } from "../src/cli/proxy/stats"
import { costOf, readUsage, usageFiles } from "../src/cli/usage"

const at = (iso: string) => new Date(iso).getTime()

function usageLine(id: string, timestamp: string, usage: Record<string, unknown>, model = "claude-opus-5-5", requestId = `req-${id}`) {
  return JSON.stringify({ type: "assistant", timestamp, requestId, message: { id, model, role: "assistant", content: [], usage: { service_tier: "standard", ...usage } } })
}

function claudeDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "eunoe-stats-"))
  const project = path.join(dir, "projects", "-repo")
  mkdirSync(project, { recursive: true })
  return { dir, project }
}

function write(file: string, lines: string[], mtime = new Date()) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${lines.join("\n")}\n`)
  utimesSync(file, mtime, mtime)
}

describe("usage from session files", () => {
  test("a response written as several lines counts once, with its final output count", () => {
    const { dir, project } = claudeDir()
    write(path.join(project, "a.jsonl"), [
      usageLine("m1", "2026-10-12T10:00:00Z", { input_tokens: 2, output_tokens: 8, cache_read_input_tokens: 1000 }),
      usageLine("m1", "2026-10-12T10:00:01Z", { input_tokens: 2, output_tokens: 300, cache_read_input_tokens: 1000 }),
      usageLine("m1", "2026-10-12T10:00:02Z", { input_tokens: 2, output_tokens: 154, cache_read_input_tokens: 1000 }),
    ])
    const usage = readUsage(usageFiles([dir], 0), 0)
    expect(usage).toHaveLength(1)
    expect(usage[0].output).toBe(300)
  })

  test("the same response copied into another session file counts once", () => {
    const { dir, project } = claudeDir()
    const line = usageLine("m1", "2026-10-12T10:00:00Z", { input_tokens: 2, output_tokens: 10 })
    write(path.join(project, "a.jsonl"), [line])
    write(path.join(project, "b.jsonl"), [line])
    expect(readUsage(usageFiles([dir], 0), 0)).toHaveLength(1)
  })

  test("placeholder usage written by copies without the API's fields never replaces or adds to the real one", () => {
    const { dir, project } = claudeDir()
    const placeholder = (id: string) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-10-12T10:00:00Z",
        requestId: `req-${id}`,
        message: { id, model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      })
    write(path.join(project, "a.jsonl"), [placeholder("m1"), usageLine("m1", "2026-10-12T10:00:00Z", { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 9000 }), placeholder("m2")])
    const usage = readUsage(usageFiles([dir], 0), 0)
    expect(usage).toHaveLength(1)
    expect(usage[0].input).toBe(2)
    expect(usage[0].cacheRead).toBe(9000)
  })

  test("synthetic messages are not requests", () => {
    const { dir, project } = claudeDir()
    write(path.join(project, "a.jsonl"), [usageLine("m1", "2026-10-12T10:00:00Z", { input_tokens: 0, output_tokens: 0 }, "<synthetic>")])
    expect(readUsage(usageFiles([dir], 0), 0)).toHaveLength(0)
  })

  test("subagent files count, and files untouched since the start of the range are skipped", () => {
    const { dir, project } = claudeDir()
    write(path.join(project, "a.jsonl"), [usageLine("m1", "2026-10-12T10:00:00Z", { output_tokens: 1 })])
    write(path.join(project, "a", "subagents", "agent-x.jsonl"), [usageLine("m2", "2026-10-12T11:00:00Z", { output_tokens: 1 })])
    write(path.join(project, "old.jsonl"), [usageLine("m3", "2026-09-01T10:00:00Z", { output_tokens: 1 })], new Date("2026-09-01T10:00:00Z"))
    const since = at("2026-10-01T00:00:00Z")
    expect(
      usageFiles([dir], since)
        .map((file) => path.basename(file))
        .sort(),
    ).toEqual(["a.jsonl", "agent-x.jsonl"])
    expect(readUsage(usageFiles([dir], since), since).map((entry) => entry.output)).toEqual([1, 1])
  })
})

describe("cost", () => {
  const entry = { at: 0, model: "claude-opus-5-5", input: 1e6, output: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6, fast: false }

  test("each token kind is priced at the model's list price, 1-hour cache writes at twice the input price", () => {
    expect(costOf(entry)).toBeCloseTo(4 + 20 + 4 * 1.25 + 4 * 2 + 0.2, 6)
    expect(costOf({ ...entry, model: "claude-fable-5-1" })).toBeCloseTo(10 + 50 + 12.5 + 20 + 0.25, 6)
    expect(costOf({ ...entry, model: "claude-haiku-4-5-20251001" })).toBeCloseTo(1 + 5 + 1.25 + 2 + 0.1, 6)
  })

  test("the longest matching model id wins, fast mode doubles, unknown models have no price", () => {
    expect(costOf({ ...entry, model: "claude-opus-5" })).toBeCloseTo(5 + 25 + 6.25 + 10 + 0.5, 6)
    expect(costOf({ ...entry, fast: true })).toBeCloseTo(2 * (4 + 20 + 5 + 8 + 0.2), 6)
    expect(costOf({ ...entry, model: "gpt-9" })).toBeNull()
    expect(summarize([{ ...entry, model: "gpt-9" }, entry]).unpriced).toBe(1)
  })

  test("a 1-hour cache write is read from the usage breakdown, the rest is 5-minute", () => {
    const { dir, project } = claudeDir()
    write(path.join(project, "a.jsonl"), [usageLine("m1", "2026-10-12T10:00:00Z", { cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 700, ephemeral_5m_input_tokens: 300 } })])
    const [usage] = readUsage(usageFiles([dir], 0), 0)
    expect(usage.cacheWrite1h).toBe(700)
    expect(usage.cacheWrite5m).toBe(300)
  })
})

describe("buckets", () => {
  test("days run midnight to midnight and end today; weeks start on Monday", () => {
    const now = new Date(2026, 9, 13, 15, 0).getTime()
    const days = buckets(now, false, 7)
    expect(days).toHaveLength(7)
    expect(days[0].start).toBe(new Date(2026, 9, 7).getTime())
    expect(days[6].start).toBe(new Date(2026, 9, 13).getTime())
    const weeks = buckets(now, true, 2)
    expect(weeks.map((week) => week.start)).toEqual([new Date(2026, 9, 5).getTime(), new Date(2026, 9, 12).getTime()])
  })
})

describe("eunoe stats", () => {
  test("each response lands on its own day, the total adds them up, and eunoe's savings come from its request log", () => {
    const home = mkdtempSync(path.join(tmpdir(), "eunoe-stats-home-"))
    const project = path.join(home, ".claude", "projects", "-repo")
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    const yesterday = new Date(today.getTime() - 86_400_000)
    write(path.join(project, "a.jsonl"), [
      usageLine("m1", yesterday.toISOString(), { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 1_000_000 }),
      usageLine("m2", today.toISOString(), { input_tokens: 500, output_tokens: 1000, cache_read_input_tokens: 2_000_000 }),
      usageLine("m2", today.toISOString(), { input_tokens: 500, output_tokens: 1500, cache_read_input_tokens: 2_000_000 }),
    ])
    mkdirSync(path.join(home, ".eunoe"), { recursive: true })
    writeFileSync(
      path.join(home, ".eunoe", "requests.jsonl"),
      `${JSON.stringify({ ts: today.toISOString(), thread: "s", input: 2_000_500, cacheRead: 2_000_000, cacheWrite: 0, uncached: 500, charsIn: 3_000, charsOut: 1_000, compacted: true })}\n`,
    )
    const out = Bun.spawnSync(["bun", path.join(import.meta.dir, "..", "src", "cli", "main.ts"), "stats", "--days", "3"], {
      env: { ...process.env, HOME: home, EUNOE_DIR: path.join(home, ".eunoe"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"), NO_COLOR: "1" },
    }).stdout.toString()
    const rowOf = (label: string) => out.split("\n").find((line) => line.trim().startsWith(label)) ?? ""
    const dayLabel = (date: Date) => date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    expect(rowOf(dayLabel(yesterday))).toMatch(/\s1\s+1\.0k\s+2\.0k\s+0\s+1\.0M\s+\$0\.24/)
    expect(rowOf(dayLabel(today))).toMatch(/\s1\s+500\s+1\.5k\s+0\s+2\.0M\s+\$0\.43/)
    expect(rowOf(dayLabel(today))).toContain("4.0M 1 fold")
    expect(rowOf(dayLabel(today))).toContain("$0.80 65%")
    expect(rowOf("Total")).toMatch(/\s2\s+1\.5k\s+3\.5k\s+0\s+3\.0M\s+\$0\.68/)
    expect(out).toContain("claude-opus-5-5")
  })
})

describe("cost saved", () => {
  const entry = { at: at("2026-10-12T10:00:00Z"), model: "claude-opus-5-5", input: 10, output: 1_000, cacheWrite5m: 0, cacheWrite1h: 5_000, cacheRead: 100_000, fast: false }
  const record = { ts: "2026-10-12T10:00:03Z", input: 105_010, cacheRead: 100_000, cacheWrite: 5_000, uncached: 10, charsIn: 300_000, charsOut: 100_000 }

  test("each logged request is matched to the response with its exact cache counts, the nearest in time within ten minutes", () => {
    const early = { ...entry, at: at("2026-10-12T09:00:00Z") }
    const other = { ...entry, cacheRead: 99_999 }
    expect(matchLogged([early, entry, other], [record]).get(record)).toBe(entry)
    expect(matchLogged([early], [record]).get(record)).toBeUndefined()
  })

  test("tokens kept out are priced as cache reads, and a fold pays back everything it rewrote at the cache-write price", () => {
    const saved = 2 * 105_010
    expect(costSaved(record, entry)).toBeCloseTo((saved * 0.2) / 1e6, 9)
    expect(costSaved({ ...record, compacted: true }, entry)).toBeCloseTo((saved * 0.2 - 5_000 * (4 * 2 - 0.2)) / 1e6, 9)
    expect(costSaved({ ...record, charsIn: undefined }, entry)).toBeNull()
    expect(costSaved(record, { ...entry, model: "gpt-9" })).toBeNull()
  })

  test("a fold that rewrites more than it saves shows as a loss, not a saving", () => {
    expect(costSaved({ ...record, charsIn: 100_100, compacted: true }, entry)).toBeLessThan(0)
  })

  test("requests that can't be priced are counted by reason and left out of the share", () => {
    const unsized = { ...record, ts: "2026-10-12T10:00:04Z", charsIn: undefined }
    const unmatched = { ...record, cacheRead: 1 }
    const sum = savings([record, unsized, unmatched, { ts: record.ts }], matchLogged([entry], [record, unsized, unmatched]))
    expect(sum).toMatchObject({ handled: 3, priced: 1, unsized: 1, unmatched: 1 })
    expect(sum.actual).toBeCloseTo(costOf(entry) ?? 0, 9)
  })
})

describe("compactions avoided", () => {
  const record = (thread: string, plain: number, minute: number) => ({ ts: `2026-10-12T10:${String(minute).padStart(2, "0")}:00Z`, thread, window: 1_000_000, input: 100_000, charsOut: 100_000, charsIn: plain, charsFixed: 20_000 })

  test("each conversation counts once per window filled, starting again from a summary", () => {
    const records = [record("a", 500_000, 0), record("a", 930_000, 1), record("a", 950_000, 2), record("a", 1_900_000, 3), record("b", 400_000, 4)]
    const avoided = nativeCompactions(records)
    expect([...avoided].map((r) => r.ts)).toEqual([records[1].ts, records[3].ts])
  })

  test("requests without a window or size are never counted", () => {
    expect(nativeCompactions([{ ts: "2026-10-12T10:00:00Z", thread: "a", input: 100, charsOut: 100, charsIn: 10_000_000 }]).size).toBe(0)
  })
})

describe("longest conversations", () => {
  const record = (thread: string, plain: number, minute: number) => ({
    ts: `2026-10-12T10:${String(minute).padStart(2, "0")}:00Z`,
    thread,
    window: 1_000_000,
    input: 100_000,
    charsOut: 100_000,
    charsIn: plain,
    charsFixed: 20_000,
    turns: minute,
  })

  test("each conversation's peak is its full history, with the compactions it would have needed", () => {
    const records = [record("a", 500_000, 0), record("a", 1_900_000, 1), record("b", 400_000, 2)]
    const peaks = threadPeaks(records, nativeCompactions(records))
    expect(peaks.map((p) => [p.thread, p.plain, p.sent, p.compactions])).toEqual([
      ["a", 1_900_000, 100_000, 1],
      ["b", 400_000, 100_000, 0],
    ])
  })
})
