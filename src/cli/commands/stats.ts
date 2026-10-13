import { claudeConfigDirs, readConfig } from "../../config"
import type { Command } from "../command"
import { cleanupDays } from "../proxy/claude-settings"
import { type RequestRecord, recentRequests } from "../proxy/inspect"
import { savedTokens, totals } from "../proxy/stats"
import { c, fail, line, percent, plural, table, tokens, wrap } from "../terminal/ui"
import { costOf, ratesOf, readUsage, type UsageEntry, usageFiles } from "../usage"

interface Bucket {
  start: number
  label: string
  usage: UsageEntry[]
  logged: RequestRecord[]
}

type Matched = Map<RequestRecord, UsageEntry>

const DAY = 86_400_000
const MATCH_WITHIN = 10 * 60_000
const NOTE_WIDTH = 110
const DEFAULT_DAYS = 7
const DEFAULT_WEEKS = 8

const midnight = (ms: number) => new Date(new Date(ms).toDateString()).getTime()
const addDays = (ms: number, days: number) => {
  const date = new Date(ms)
  date.setDate(date.getDate() + days)
  return date.getTime()
}
const monday = (ms: number) => addDays(midnight(ms), -((new Date(ms).getDay() + 6) % 7))
const short = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
const dayLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
const dollars = (amount: number) => `$${amount >= 100 ? Math.round(amount).toLocaleString() : amount.toFixed(2)}`

export function buckets(now: number, weekly: boolean, count: number): Bucket[] {
  const step = weekly ? 7 : 1
  const last = weekly ? monday(now) : midnight(now)
  return Array.from({ length: count }, (_, i) => {
    const start = addDays(last, -step * (count - 1 - i))
    const label = weekly ? `${short(start)} – ${short(addDays(start, 6))}` : dayLabel(start)
    return { start, label, usage: [], logged: [] }
  })
}

function place(list: Bucket[], at: number, add: (bucket: Bucket) => void) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (at < list[i].start) continue
    add(list[i])
    return
  }
}

export function summarize(usage: UsageEntry[]) {
  const sum = { requests: usage.length, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, unpriced: 0 }
  for (const entry of usage) {
    sum.input += entry.input
    sum.output += entry.output
    sum.cacheWrite += entry.cacheWrite5m + entry.cacheWrite1h
    sum.cacheRead += entry.cacheRead
    const cost = costOf(entry)
    if (cost === null) sum.unpriced += 1
    else sum.cost += cost
  }
  return sum
}

const usageKey = (cacheRead: number, cacheWrite: number, uncached: number) => `${cacheRead}:${cacheWrite}:${uncached}`

export function matchLogged(usage: UsageEntry[], logged: RequestRecord[]): Matched {
  const index = new Map<string, UsageEntry[]>()
  for (const entry of usage) {
    const key = usageKey(entry.cacheRead, entry.cacheWrite5m + entry.cacheWrite1h, entry.input)
    index.set(key, [...(index.get(key) ?? []), entry])
  }
  const matched: Matched = new Map()
  for (const record of logged) {
    if (!record.input) continue
    const at = Date.parse(record.ts)
    const distance = (entry: UsageEntry) => Math.abs(entry.at - at)
    const nearest = (index.get(usageKey(record.cacheRead ?? 0, record.cacheWrite ?? 0, record.uncached ?? 0)) ?? []).reduce<UsageEntry | null>((best, entry) => (!best || distance(entry) < distance(best) ? entry : best), null)
    if (nearest && distance(nearest) <= MATCH_WITHIN) matched.set(record, nearest)
  }
  return matched
}

export function costSaved(record: RequestRecord, entry: UsageEntry): number | null {
  const saved = savedTokens(record)
  const rates = ratesOf(entry)
  if (saved === null || !rates) return null
  const foldRewrite = record.compacted ? (record.cacheWrite ?? 0) * (rates.write - rates.read) : 0
  return saved * rates.read - foldRewrite
}

export function savings(logged: RequestRecord[], matched: Matched) {
  const sum = { handled: 0, priced: 0, unsized: 0, unmatched: 0, actual: 0, saved: 0 }
  for (const record of logged) {
    if (!record.input) continue
    sum.handled += 1
    const entry = matched.get(record)
    if (savedTokens(record) === null) sum.unsized += 1
    else if (!entry) sum.unmatched += 1
    const saved = entry ? costSaved(record, entry) : null
    const actual = entry ? costOf(entry) : null
    if (saved === null || actual === null) continue
    sum.priced += 1
    sum.actual += actual
    sum.saved += saved
  }
  return sum
}

function leftOut(sum: ReturnType<typeof savings>) {
  const reasons = [
    sum.unsized ? `${sum.unsized.toLocaleString()} predate size logging` : "",
    sum.unmatched ? `${sum.unmatched.toLocaleString()} aren't in session files` : "",
    sum.handled - sum.priced - sum.unsized - sum.unmatched > 0 ? `${sum.handled - sum.priced - sum.unsized - sum.unmatched} to models without a price` : "",
  ]
  const listed = reasons.filter(Boolean)
  return listed.length > 1 ? `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}` : listed.join("")
}

function notSentCell(logged: RequestRecord[]) {
  const sum = totals(logged)
  if (sum.requests === 0) return c.dim("–")
  if (sum.saved <= 0) return c.dim("±0")
  return `${tokens(sum.saved)} ${c.dim(plural(sum.folds, "fold"))}`
}

function costSavedCell(logged: RequestRecord[], matched: Matched) {
  const sum = savings(logged, matched)
  if (sum.priced === 0) return c.dim("–")
  if (Math.abs(sum.saved) < 0.005) return c.dim("±0")
  const share = c.dim(percent(sum.saved / (sum.actual + sum.saved)))
  return sum.saved > 0 ? `${c.green(c.bold(dollars(sum.saved)))} ${share}` : `${c.yellow(`−${dollars(-sum.saved)}`)} ${share}`
}

function row(label: string, usage: UsageEntry[], logged: RequestRecord[], matched: Matched, bold = false) {
  const sum = summarize(usage)
  const strong = (text: string) => (bold ? c.bold(text) : text)
  const eunoe = [notSentCell(logged), costSavedCell(logged, matched)]
  if (sum.requests === 0) return [strong(label), c.dim("–"), "", "", "", "", "", ...eunoe]
  return [strong(label), strong(sum.requests.toLocaleString()), tokens(sum.input), tokens(sum.output), tokens(sum.cacheWrite), tokens(sum.cacheRead), strong(`${dollars(sum.cost)}${sum.unpriced ? c.dim("*") : ""}`), ...eunoe]
}

function byModel(usage: UsageEntry[]) {
  const models = new Map<string, UsageEntry[]>()
  for (const entry of usage) models.set(entry.model, [...(models.get(entry.model) ?? []), entry])
  const total = summarize(usage).cost
  return [...models]
    .map(([model, entries]) => ({ model, sum: summarize(entries) }))
    .sort((a, b) => b.sum.cost - a.sum.cost || b.sum.requests - a.sum.requests)
    .map(({ model, sum }) => [
      model,
      sum.requests.toLocaleString(),
      tokens(sum.input),
      tokens(sum.output),
      tokens(sum.cacheWrite),
      tokens(sum.cacheRead),
      sum.unpriced ? c.dim("no price") : c.bold(dollars(sum.cost)),
      c.dim(total > 0 && !sum.unpriced ? percent(sum.cost / total) : ""),
    ])
}

const countArg = (args: string[], flag: string, fallback: number) => {
  const at = args.indexOf(flag)
  if (at === -1) return fallback
  const value = Number(args[at + 1])
  if (!Number.isInteger(value) || value < 1) fail(`${flag} needs a whole number`, `eunoe stats ${flag} 14`)
  return value
}

export const stats: Command = {
  summary: "Token usage and cost by day or week, and what eunoe saved",
  usage: "eunoe stats [--days <n>] [--weekly] [--weeks <n>]",
  details: [
    "Reads the usage the API returned for every request in your Claude Code",
    "sessions, subagents included, counting each response once. Cost is at",
    "API list prices. The eunoe columns come from its request log: the input",
    "tokens it kept out of the requests it handled, and what that saved at",
    "cache-read prices once the cache writes its folds caused are paid for.",
  ],
  options: [
    ["--days <n>", `Days to show (default ${DEFAULT_DAYS})`],
    ["--weekly", `Group by week, Monday first (default ${DEFAULT_WEEKS} weeks)`],
    ["--weeks <n>", "Weeks to show; implies --weekly"],
  ],
  run(args) {
    const weekly = args.includes("--weekly") || args.includes("--weeks")
    const count = weekly ? countArg(args, "--weeks", DEFAULT_WEEKS) : countArg(args, "--days", DEFAULT_DAYS)
    const now = Date.now()
    const list = buckets(now, weekly, count)
    const since = list[0].start
    const configDirs = claudeConfigDirs(readConfig())
    const usage = readUsage(usageFiles(configDirs, since), since)
    const logged = recentRequests(Number.POSITIVE_INFINITY).filter((record) => Date.parse(record.ts) >= since)
    for (const entry of usage) place(list, entry.at, (bucket) => bucket.usage.push(entry))
    const matched = matchLogged(usage, logged)
    for (const record of logged) place(list, Date.parse(record.ts), (bucket) => bucket.logged.push(record))

    line()
    line(`  ${c.bold("eunoe stats")}  ${c.dim(`the last ${count} ${weekly ? "weeks" : "days"} of Claude Code, from your session files`)}`)
    line()
    table([
      [weekly ? "Week" : "Day", "Requests", "Input", "Output", "Cache write", "Cache read", "API cost", "Not sent by eunoe", "Cost saved"].map((title) => c.dim(title)),
      ...list.map((bucket) => row(bucket.label, bucket.usage, bucket.logged, matched)),
      row("Total", usage, logged, matched, true),
    ])

    const models = byModel(usage)
    if (models.length > 0) {
      line()
      table([["Model", "Requests", "Input", "Output", "Cache write", "Cache read", "API cost", "Share"].map((title) => c.dim(title)), ...models])
    }

    const keepDays = cleanupDays(configDirs)
    const handled = savings(logged, matched)
    const notes: Array<[label: string, text: string]> = [
      ["API cost", "At list prices, including cache writes and fast mode."],
      ["Not sent", "Input eunoe kept out, mostly history Claude Code would have read from cache."],
      ["Cost saved", "Those tokens at cache-read prices, minus what each fold cost to rewrite."],
      ...(handled.priced < handled.handled ? [["Not priced", `${(handled.handled - handled.priced).toLocaleString()} of ${handled.handled.toLocaleString()} eunoe requests: ${leftOut(handled)}.`] as [string, string]] : []),
      ...(summarize(usage).unpriced ? [["* No price", "Some models have no known price, so their tokens count but their cost doesn't."] as [string, string]] : []),
      ...(since < now - keepDays * DAY ? [["History", `Claude Code deletes sessions after ${keepDays} idle days, so older rows may be incomplete.`] as [string, string]] : []),
    ]
    const labelWidth = Math.max(...notes.map(([label]) => label.length)) + 3
    const width = Math.min(process.stdout.columns || NOTE_WIDTH, NOTE_WIDTH) - 2 - labelWidth
    for (const [label, text] of notes) {
      line()
      for (const [index, part] of wrap(text, width).entries()) line(`  ${c.dim((index === 0 ? label : "").padEnd(labelWidth))}${part}`)
    }
    line()
  },
}
