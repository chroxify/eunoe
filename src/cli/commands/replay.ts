import { closeSync, openSync, readSync, statSync } from "node:fs"
import { cpus } from "node:os"
import path from "node:path"
import { claudeConfigDirs, DEFAULTS, parseTunable, readConfig } from "../../config"
import { listEntries, projectFolderName, projectFolders } from "../../transcript/locate"
import type { Command } from "../command"
import { cleanupDays } from "../proxy/claude-settings"
import { recentRequests } from "../proxy/inspect"
import type { ReplayedSession, ReplayFailure, ReplayOptions } from "../replay"
import { shortId } from "../sessions"
import { c, fail, line, percent, plural, rows, table, tilde, tokens, useColor, warn } from "../terminal/ui"

interface Target {
  file: string
  bytes: number
  lastActive: number
}

const WINDOW = 1_000_000
const HEAD_BYTES = 64 * 1024
const TOP_SESSIONS = 10

function targets(configDirs: string[], ids: string[], here: string | null): Target[] {
  const seen = new Map<string, Target>()
  const wanted = (id: string) => ids.length === 0 || ids.some((prefix) => id.startsWith(prefix))
  const onlyFolder = here ? projectFolderName(here) : null
  for (const folder of projectFolders(configDirs)) {
    if (onlyFolder && path.basename(folder) !== onlyFolder) continue
    for (const name of listEntries(folder)) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(name)) continue
      const id = name.slice(0, -".jsonl".length)
      if (!wanted(id) || seen.has(id)) continue
      const file = path.join(folder, name)
      const stat = statSync(file)
      seen.set(id, { file, bytes: stat.size, lastActive: stat.mtimeMs })
    }
  }
  return [...seen.values()].sort((a, b) => b.bytes - a.bytes)
}

function fixedTokens(): { value: number; measured: boolean } {
  const sizes = recentRequests()
    .flatMap((r) => (r.charsFixed && r.charsOut && r.input ? [Math.round((r.input * r.charsFixed) / r.charsOut)] : []))
    .sort((a, b) => a - b)
  if (sizes.length === 0) return { value: 30_000, measured: false }
  return { value: sizes[Math.floor(sizes.length / 2)], measured: true }
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })

const duration = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)
const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`)
const fewer = (plain: number, eunoe: number) => (plain > 0 ? percent(1 - eunoe / plain) : "–")

function startedAt(target: Target): number {
  const buffer = Buffer.alloc(HEAD_BYTES)
  let read = 0
  try {
    const fd = openSync(target.file, "r")
    read = readSync(fd, buffer, 0, HEAD_BYTES, 0)
    closeSync(fd)
  } catch {
    return target.lastActive
  }
  const found = /"timestamp":"([^"]+)"/.exec(buffer.toString("utf8", 0, read))
  const at = found ? Date.parse(found[1]) : Number.NaN
  return Number.isNaN(at) ? target.lastActive : Math.min(at, target.lastActive)
}

function historyLine(list: Target[], keepDays: number): string {
  const span = `${day(Math.min(...list.map(startedAt)))} – ${day(Math.max(...list.map((t) => t.lastActive)))}`
  return `${span}  ${c.dim(`· the sessions still on disk; Claude Code deletes sessions idle for ${keepDays} days (cleanupPeriodDays), so totals cover a moving window`)}`
}

async function replayAll(list: Target[], options: ReplayOptions, onDone: (done: number, bytes: number) => void): Promise<{ results: ReplayedSession[]; failures: ReplayFailure[] }> {
  const results: ReplayedSession[] = []
  const failures: ReplayFailure[] = []
  const queue = [...list]
  let bytesDone = 0
  const workers = Math.max(1, Math.min(8, cpus().length - 1, list.length))
  await Promise.all(
    Array.from(
      { length: workers },
      () =>
        new Promise<void>((resolve) => {
          let worker = new Worker(new URL("../replay/worker.ts", import.meta.url).href)
          let current: Target | undefined
          const finish = (target: Target) => {
            bytesDone += target.bytes
            onDone(results.length + failures.length, bytesDone)
          }
          const next = () => {
            current = queue.shift()
            if (!current) {
              worker.terminate()
              resolve()
              return
            }
            worker.postMessage({ file: current.file, options })
          }
          const listen = () => {
            worker.onmessage = (event: MessageEvent<ReplayedSession | ReplayFailure>) => {
              if ("error" in event.data) failures.push(event.data)
              else results.push(event.data)
              if (current) finish(current)
              next()
            }
            worker.onerror = (event) => {
              event.preventDefault()
              if (current) {
                failures.push({ file: current.file, error: event.message || "worker crashed" })
                finish(current)
              }
              worker.terminate()
              worker = new Worker(new URL("../replay/worker.ts", import.meta.url).href)
              listen()
              next()
            }
          }
          listen()
          next()
        }),
    ),
  )
  return { results, failures }
}

export const replay: Command = {
  summary: "Replay your Claude Code history through eunoe and show what it saves",
  usage: "eunoe replay [session…] [--here] [--window <tokens>]",
  details: [
    "Reads every Claude Code session on this machine and replays each request",
    "through eunoe's folding, without calling Claude. Shows the input tokens",
    "and the cache-weighted cost plain Claude Code would have paid against what",
    "eunoe would have sent, the folds it would have made, and the compactions",
    "Claude Code would have needed. Deterministic and offline.",
  ],
  options: [
    ["--here", "Only sessions from the current directory"],
    ["--window <tokens>", `Context window to assume (default ${tokens(WINDOW)})`],
    ["--turn-cap <tokens|off>", "Override the turnCap setting for this replay"],
  ],
  async run(args) {
    const windowAt = args.indexOf("--window")
    const capAt = args.indexOf("--turn-cap")
    const optionValues = [windowAt, capAt].filter((at) => at !== -1).map((at) => args[at + 1])
    const ids = args.filter((a) => !a.startsWith("-") && !optionValues.includes(a))
    const window = windowAt === -1 ? WINDOW : Number(args[windowAt + 1])
    if (!(window > 0)) fail("--window needs a token count", "eunoe replay --window 200000")
    const config = readConfig()
    const turnCap = capAt === -1 ? config.turnCap : parseTunable("turnCap", args[capAt + 1] ?? "")
    if (turnCap === null) fail("--turn-cap needs a token count or off", "eunoe replay --turn-cap off")
    const configDirs = claudeConfigDirs(config)
    const list = targets(configDirs, ids, args.includes("--here") ? process.cwd() : null)
    if (list.length === 0) fail("No Claude Code sessions found.")
    const totalBytes = list.reduce((total, entry) => total + entry.bytes, 0)
    const fixed = fixedTokens()
    line()
    const options: ReplayOptions = { config: { ...config, turnCap, mode: config.mode === "off" ? DEFAULTS.mode : config.mode }, window, fixedTokens: fixed.value }
    const started = Date.now()
    const progress = useColor && process.stdout.isTTY
    const { results, failures } = await replayAll(list, options, (done, doneBytes) => {
      if (!progress) return
      const left = doneBytes > 0 ? ` · ~${duration(((Date.now() - started) / doneBytes) * (totalBytes - doneBytes))} left` : ""
      process.stdout.write(`\r\x1b[K  ${c.dim(`Replaying ${done} / ${list.length} sessions · ${size(doneBytes)} of ${size(totalBytes)}${left}`)}`)
    })
    if (progress) process.stdout.write("\r\x1b[K")
    const sum = results.reduce(
      (acc, r) => {
        for (const key of ["requests", "folds", "dropped", "nativeCompactions", "discarded", "plainTokens", "eunoeTokens", "plainCost", "eunoeCost"] as const) acc[key] += r[key]
        acc.peakPlain = Math.max(acc.peakPlain, r.peakPlain)
        acc.peakEunoe = Math.max(acc.peakEunoe, r.peakEunoe)
        return acc
      },
      { requests: 0, folds: 0, dropped: 0, nativeCompactions: 0, discarded: 0, plainTokens: 0, eunoeTokens: 0, plainCost: 0, eunoeCost: 0, peakPlain: 0, peakEunoe: 0 },
    )
    const compared = results.filter((r) => r.requests > 0)
    line(`  ${c.bold("eunoe replay")}  ${c.dim("your Claude Code history, as eunoe would have sent it")}`)
    line()
    rows(
      [
        ["Sessions", `${c.bold(compared.length.toLocaleString())} replayed  ${c.dim("·")}  ${size(totalBytes)}  ${c.dim("·")}  ${duration(Date.now() - started)}`],
        ["History", historyLine(list, cleanupDays(configDirs))],
        ["Requests", c.bold(sum.requests.toLocaleString())],
        ["Window", `${tokens(window)}  ${c.dim(`· ${tokens(fixed.value)} of it system prompt and tools, ${fixed.measured ? "from your logged requests" : "assumed"}`)}`],
      ],
      4,
    )
    line()
    rows(
      [
        [
          "History kept",
          `eunoe ${c.bold(c.green("every turn"))}, folded or whole  ${c.dim("·")}  Claude Code compacted ${c.bold(sum.nativeCompactions.toLocaleString())} time${sum.nativeCompactions === 1 ? "" : "s"}, ${c.bold(tokens(sum.discarded))} tokens of conversation replaced by summaries`,
        ],
        [
          "Input tokens",
          `plain ${tokens(sum.plainTokens)}  ${c.dim("→")}  eunoe ${c.bold(tokens(sum.eunoeTokens))} tokens   ${c.green(c.bold(`${fewer(sum.plainTokens, sum.eunoeTokens)} fewer`))}  ${c.dim("the conversation; system prompt and tools are the same on both sides")}`,
        ],
        ["Cost", `${c.green(c.bold(`${fewer(sum.plainCost, sum.eunoeCost)} cheaper`))}  ${c.dim("cache reads at 0.1×, writes at 1.25×")}`],
        ["Folds", c.bold(sum.folds.toLocaleString())],
        ["Folds dropped", `${c.bold(sum.dropped.toLocaleString())} ${c.dim("folded turns removed entirely to fit the window")}`],
        ["Peak context", `plain ${tokens(sum.peakPlain)}  ${c.dim("→")}  eunoe ${c.bold(tokens(sum.peakEunoe))}`],
      ],
      4,
    )
    const saved = [...compared]
      .filter((r) => r.nativeCompactions > 0)
      .sort((a, b) => b.discarded - a.discarded)
      .slice(0, TOP_SESSIONS)
    if (saved.length > 0) {
      line()
      line(`  ${c.dim("Sessions Claude Code would have compacted, by history it would have lost")}`)
      table(
        saved.map((r) => [
          c.cyan(shortId(r.id)),
          (r.title ?? (r.cwd ? tilde(r.cwd) : "")).slice(0, 40),
          c.bold(c.green(`${plural(r.nativeCompactions, "compaction")} avoided`)),
          `${tokens(r.discarded)} tokens kept`,
          c.dim(`${plural(r.folds, "fold")} · ${tokens(r.plainTokens)} → ${tokens(r.eunoeTokens)} tokens`),
        ]),
      )
    }
    const top = [...compared].sort((a, b) => b.plainTokens - b.eunoeTokens - (a.plainTokens - a.eunoeTokens)).slice(0, TOP_SESSIONS)
    if (top.length > 1) {
      line()
      line(`  ${c.dim("Biggest token savings")}`)
      table(
        top.map((r) => [
          c.cyan(shortId(r.id)),
          (r.title ?? (r.cwd ? tilde(r.cwd) : "")).slice(0, 40),
          `${tokens(r.plainTokens)} ${c.dim("→")} ${tokens(r.eunoeTokens)} tokens`,
          c.green(c.bold(`${tokens(r.plainTokens - r.eunoeTokens)} tokens saved`)),
          c.dim(`${fewer(r.plainTokens, r.eunoeTokens)} fewer`),
          c.dim(plural(r.folds, "fold")),
        ]),
      )
    }
    if (failures.length > 0) {
      line()
      warn(`${plural(failures.length, "session")} couldn't be replayed and ${failures.length === 1 ? "is" : "are"} not counted: ${failures.map((f) => `${shortId(path.basename(f.file, ".jsonl"))} (${f.error})`).join(", ")}`)
    }
    line()
  },
}
