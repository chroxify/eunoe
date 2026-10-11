import { statSync } from "node:fs"
import { cpus } from "node:os"
import path from "node:path"
import { claudeConfigDirs, DEFAULTS, parseTunable, readConfig } from "../../config"
import { listEntries, projectFolderName, projectFolders } from "../../transcript/locate"
import type { Command } from "../command"
import { recentRequests } from "../proxy/inspect"
import type { ReplayedSession, ReplayOptions } from "../replay"
import { shortId } from "../sessions"
import { c, fail, line, percent, plural, rows, table, tilde, tokens, useColor } from "../terminal/ui"

interface Target {
  file: string
  bytes: number
}

const WINDOW = 1_000_000
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
      seen.set(id, { file, bytes: statSync(file).size })
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

const duration = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)
const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`)
const fewer = (plain: number, eunoe: number) => (plain > 0 ? percent(1 - eunoe / plain) : "–")

async function replayAll(list: Target[], options: ReplayOptions, onDone: (done: number, bytes: number) => void): Promise<ReplayedSession[]> {
  const results: ReplayedSession[] = []
  const queue = [...list]
  let bytesDone = 0
  const workers = Math.max(1, Math.min(8, cpus().length - 1, list.length))
  await Promise.all(
    Array.from(
      { length: workers },
      () =>
        new Promise<void>((resolve) => {
          const worker = new Worker(new URL("../replay/worker.ts", import.meta.url).href)
          const next = () => {
            const target = queue.shift()
            if (!target) {
              worker.terminate()
              resolve()
              return
            }
            worker.postMessage({ file: target.file, options })
          }
          worker.onmessage = (event: MessageEvent<ReplayedSession>) => {
            results.push(event.data)
            bytesDone += event.data.bytes
            onDone(results.length, bytesDone)
            next()
          }
          worker.onerror = () => next()
          next()
        }),
    ),
  )
  return results
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
    const list = targets(claudeConfigDirs(config), ids, args.includes("--here") ? process.cwd() : null)
    if (list.length === 0) fail("No Claude Code sessions found.")
    const totalBytes = list.reduce((total, entry) => total + entry.bytes, 0)
    const fixed = fixedTokens()
    line()
    const options: ReplayOptions = { config: { ...config, turnCap, mode: config.mode === "off" ? DEFAULTS.mode : config.mode }, window, fixedTokens: fixed.value }
    const started = Date.now()
    const progress = useColor && process.stdout.isTTY
    const results = await replayAll(list, options, (done, doneBytes) => {
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
        ["Sessions", `${c.bold(String(compared.length))} replayed  ${c.dim("·")}  ${size(totalBytes)}  ${c.dim("·")}  ${duration(Date.now() - started)}`],
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
          `eunoe ${c.bold(c.green("every turn"))}, folded or whole  ${c.dim("·")}  Claude Code compacted ${c.bold(String(sum.nativeCompactions))} time${sum.nativeCompactions === 1 ? "" : "s"}, ${c.bold(tokens(sum.discarded))} tokens of conversation replaced by summaries`,
        ],
        [
          "Input tokens",
          `plain ${tokens(sum.plainTokens)}  ${c.dim("→")}  eunoe ${c.bold(tokens(sum.eunoeTokens))} tokens   ${c.green(c.bold(`${fewer(sum.plainTokens, sum.eunoeTokens)} fewer`))}  ${c.dim("the conversation; system prompt and tools are the same on both sides")}`,
        ],
        ["Cost", `${c.green(c.bold(`${fewer(sum.plainCost, sum.eunoeCost)} cheaper`))}  ${c.dim("cache reads at 0.1×, writes at 1.25×")}`],
        ["Folds", c.bold(String(sum.folds))],
        ["Folds dropped", `${c.bold(String(sum.dropped))} ${c.dim("folded turns removed entirely to fit the window")}`],
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
    line()
  },
}
