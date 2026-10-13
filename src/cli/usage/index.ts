import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { listEntries, projectFolders } from "../../transcript/locate"
import { subagentsDir } from "../../transcript/subagents"

export interface UsageEntry {
  at: number
  model: string
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  fast: boolean
}

interface Price {
  input: number
  output: number
  cacheRead: number
}

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  service_tier?: string
  speed?: string
}

interface RawLine {
  timestamp?: string
  requestId?: string
  message?: { id?: string; model?: string; usage?: RawUsage }
}

const PRICES: Array<[prefix: string, price: Price]> = [
  ["claude-fable-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-mythos-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-fable-5", { input: 10, output: 50, cacheRead: 1 }],
  ["claude-mythos-5", { input: 10, output: 50, cacheRead: 1 }],
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2 }],
  ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-8", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-7", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-6", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-5", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-4", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1 }],
]

const CACHE_WRITE_5M = 1.25
const CACHE_WRITE_1H = 2
const FAST_MULTIPLIER = 2
const PLACEHOLDER_INPUT = 1000

const priceFor = (model: string) => PRICES.find(([prefix]) => model === prefix || model.startsWith(`${prefix}-`))?.[1] ?? null

export function ratesOf(entry: UsageEntry): { read: number; write: number } | null {
  const price = priceFor(entry.model)
  if (!price) return null
  const writes = entry.cacheWrite5m + entry.cacheWrite1h
  const writeShare = writes > 0 ? (entry.cacheWrite5m * CACHE_WRITE_5M + entry.cacheWrite1h * CACHE_WRITE_1H) / writes : CACHE_WRITE_1H
  const scale = (entry.fast ? FAST_MULTIPLIER : 1) / 1e6
  return { read: price.cacheRead * scale, write: price.input * writeShare * scale }
}

export function costOf(entry: UsageEntry): number | null {
  const price = priceFor(entry.model)
  if (!price) return null
  const dollars = entry.input * price.input + entry.output * price.output + entry.cacheRead * price.cacheRead + entry.cacheWrite5m * price.input * CACHE_WRITE_5M + entry.cacheWrite1h * price.input * CACHE_WRITE_1H
  return (dollars / 1e6) * (entry.fast ? FAST_MULTIPLIER : 1)
}

const fromApi = (usage: RawUsage) => usage.service_tier !== undefined

const isPlaceholder = (usage: RawUsage) => !fromApi(usage) && usage.input_tokens === PLACEHOLDER_INPUT && !usage.cache_read_input_tokens && !usage.cache_creation_input_tokens

const supersedes = (next: RawUsage, known: RawUsage) =>
  fromApi(next) !== fromApi(known)
    ? fromApi(next)
    : (next.output_tokens ?? 0) > (known.output_tokens ?? 0) || ((next.output_tokens ?? 0) === (known.output_tokens ?? 0) && (next.cache_creation_input_tokens ?? 0) > (known.cache_creation_input_tokens ?? 0))

function entryOf(line: RawLine, usage: RawUsage, at: number): UsageEntry {
  const written = usage.cache_creation_input_tokens ?? 0
  const hour = Math.min(written, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0)
  return {
    at,
    model: line.message?.model ?? "unknown",
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheWrite5m: written - hour,
    cacheWrite1h: hour,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    fast: usage.speed === "fast",
  }
}

export function usageFiles(configDirs: string[], since: number): string[] {
  const files: string[] = []
  const recent = (file: string) => {
    try {
      return statSync(file).mtimeMs >= since
    } catch {
      return false
    }
  }
  for (const folder of projectFolders(configDirs)) {
    for (const name of listEntries(folder)) {
      if (!name.endsWith(".jsonl")) continue
      const file = path.join(folder, name)
      if (recent(file)) files.push(file)
      const subagents = subagentsDir(file)
      for (const agent of listEntries(subagents)) if (agent.endsWith(".jsonl") && recent(path.join(subagents, agent))) files.push(path.join(subagents, agent))
    }
  }
  return files.sort()
}

export function readUsage(files: string[], since: number): UsageEntry[] {
  const seen = new Map<string, { usage: RawUsage; entry: UsageEntry }>()
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const [index, raw] of text.split("\n").entries()) {
      if (!raw.includes('"usage"')) continue
      let line: RawLine
      try {
        line = JSON.parse(raw)
      } catch {
        continue
      }
      const usage = line.message?.usage
      const at = Date.parse(line.timestamp ?? "")
      if (!usage || !(at >= since) || line.message?.model === "<synthetic>") continue
      const key = line.message?.id ? `${line.message.id}:${line.requestId ?? ""}` : `${file}:${index}`
      const known = seen.get(key)
      if (known && !supersedes(usage, known.usage)) continue
      seen.set(key, { usage, entry: entryOf(line, usage, at) })
    }
  }
  return [...seen.values()].filter(({ usage }) => !isPlaceholder(usage)).map(({ entry }) => entry)
}
