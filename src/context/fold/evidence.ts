import { type Block, blocks, clip, describeToolCall, type Message, resultText } from "../content"
import { toolEvidence } from "../prompts"

export interface EvidenceOptions {
  linesPerCall?: number
  lineChars?: number
  turnChars?: number
  scanLines?: number
  minScore?: number
  allTools?: boolean
  ranked?: boolean
  labels?: boolean
  callFloor?: number
}

interface Scored {
  index: number
  line: string
  score: number
}

interface Entry {
  head: string
  lines: string[]
}

export const REREADABLE_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "Edit", "Write", "MultiEdit", "NotebookEdit"])

const ERROR_LINE = /\b(?:error|errors|fail|fails|failed|failure|fatal|exception|panic|denied|refused|timed? ?out|traceback|cannot|unable to)\b/i

const ERROR_CODE =
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b|\bSIG[A-Z]{2,}\d*\b|\b[A-Z]{2,}\d{2,}\b|\bE(?:NOENT|ACCES|PERM|EXIST|CONN(?:REFUSED|RESET|ABORTED)|PIPE|ADDRINUSE|TIMEDOUT|NOTFOUND|INVAL|BUSY|MFILE|AGAIN|HOSTUNREACH|NOTDIR|ISDIR|BADF|NOSPC|AI_[A-Z]+)\b/

const VALUE_TOKEN =
  /\b[a-z]{2,}[_-](?=[a-z0-9]*\d)[a-z0-9]{6,}\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b|https?:\/\/[^\s)"']+|\b\d{4,}\b|\b\d{6,}_[a-z0-9_]{3,}\b|\bv?\d+\.\d+\.\d+\b|\b\d+(?:\.\d+)?\s?(?:ms|s|[KMGT]i?B|kB|%)(?![a-z])|\bsha\d*:[0-9a-f]+|@[a-z][\w-]+|--[a-z][\w-]*=\S+|\b\d+ (?:pass(?:ed|ing)?|fail(?:ed|ing)?|tests?|files? changed|insertions?|deletions?|rows?|errors?|warnings?)\b|[$€£]\d+(?:[.,]\d+)?|\b(?:status|HTTP\/\d(?:\.\d)?)\s*[:=]?\s*[45]\d{2}\b|\bexit(?: code| status)?\s*[:=]?\s*(?!0\b)\d{1,3}\b/i

const ID_TOKEN = /\b[a-z]{2,}[_-](?=[a-z0-9]*\d)[a-z0-9]{6,}\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b|https?:\/\/[^\s)"']+|\b\d{6,}_[a-z0-9_]{3,}\b|\bv?\d+\.\d+\.\d+\b|\bsha\d*:[0-9a-f]+|@[a-z][\w-]+|--[a-z][\w-]*=\S+/i

const KEY_VALUE = /^[\w .\-/()]{2,48}[:=]\s*\S/

const VALUE_LABEL = /\b(?:ids?|hash|sha(?:256)?|checksum|trace|deploy(?:ment)?|preview|url|version|rows|p9[59]|exit(?: code)?|signal|request[_-]?id|job|migration|applied|bundle|build|status|took|updated|created)\b/i

function resolved(options: EvidenceOptions) {
  return {
    linesPerCall: options.linesPerCall ?? 12,
    lineChars: options.lineChars ?? 220,
    turnChars: options.turnChars ?? 4_000,
    scanLines: options.scanLines ?? 1_000_000,
    minScore: options.minScore ?? 2,
    ranked: options.ranked ?? true,
    labels: options.labels ?? true,
    callFloor: options.callFloor ?? 2,
  }
}

const isError = (line: string) => ERROR_LINE.test(line) || ERROR_CODE.test(line)

export function isSalient(line: string): boolean {
  return isError(line) || VALUE_TOKEN.test(line)
}

function scoreLines(text: string, options: EvidenceOptions): Scored[] {
  const { scanLines, lineChars, minScore, labels } = resolved(options)
  const scored = text
    .split("\n")
    .slice(0, scanLines)
    .flatMap((raw, index) => {
      const line = raw.trim()
      if (line.length < 4) return []
      const error = isError(line)
      const value = VALUE_TOKEN.test(line)
      if (!error && !value) return []
      const score = (error ? 3 : 0) + (value ? (ID_TOKEN.test(line) ? 3 : 2) : 0) + (KEY_VALUE.test(line) ? 1 : 0) + (line.length < 120 ? 1 : 0) + (labels && VALUE_LABEL.test(line) ? 1 : 0)
      return score >= minScore ? [{ index, line: clip(line, lineChars), score }] : []
    })
  const seen = new Set<string>()
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).filter((s) => !seen.has(s.line) && seen.add(s.line))
}

export function salientLines(text: string, options: EvidenceOptions = {}): string[] {
  return scoreLines(text, options)
    .slice(0, resolved(options).linesPerCall)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.line)
}

export function toolPairs(turn: Message[]): Array<{ call: Block; result: Block }> {
  const results = new Map<string, Block>()
  for (const message of turn) {
    if (message.role !== "user") continue
    for (const block of blocks(message)) if (block.type === "tool_result") results.set(block.tool_use_id, block)
  }
  return turn
    .filter((m) => m.role === "assistant")
    .flatMap((m) => blocks(m).filter((b) => b.type === "tool_use"))
    .flatMap((call) => {
      const result = results.get(call.id)
      return result ? [{ call, result }] : []
    })
}

function render(entries: Entry[]): string | null {
  const shown = entries.filter((e) => e.lines.length > 0).map((e) => `- ${e.head}:\n${e.lines.map((l) => `    ${l}`).join("\n")}`)
  return shown.length > 0 ? toolEvidence(shown) : null
}

function inCallOrder(heads: string[], pairs: Array<{ result: Block }>, options: EvidenceOptions): Entry[] {
  const { turnChars } = resolved(options)
  const entries: Entry[] = []
  let used = 0
  pairs.forEach(({ result }, i) => {
    const lines = salientLines(resultText(result), options)
    if (lines.length === 0) return
    const size = heads[i].length + 4 + lines.reduce((s, l) => s + l.length + 5, 0)
    if (used + size > turnChars) return
    entries.push({ head: heads[i], lines })
    used += size
  })
  return entries
}

function byScore(heads: string[], pairs: Array<{ result: Block }>, options: EvidenceOptions): Entry[] {
  const { turnChars, linesPerCall, callFloor } = resolved(options)
  const perCall = pairs.map(({ result }) => scoreLines(resultText(result), options))
  const chosen = new Map<number, Scored[]>()
  let used = 0
  const take = (call: number, line: Scored) => {
    const bucket = chosen.get(call) ?? []
    const cost = line.line.length + 5 + (bucket.length > 0 ? 0 : heads[call].length + 4)
    if (bucket.length >= linesPerCall || used + cost > turnChars) return
    bucket.push(line)
    chosen.set(call, bucket)
    used += cost
  }
  for (const [call, lines] of perCall.entries()) for (const line of lines.slice(0, callFloor)) take(call, line)
  const rest = perCall.flatMap((lines, call) => lines.slice(callFloor).map((line) => ({ line, call }))).sort((a, b) => b.line.score - a.line.score || a.call - b.call || a.line.index - b.line.index)
  for (const { line, call } of rest) take(call, line)
  return heads.map((head, i) => ({ head, lines: (chosen.get(i) ?? []).sort((a, b) => a.index - b.index).map((s) => s.line) }))
}

export function turnEvidence(turn: Message[], options: EvidenceOptions = {}): string | null {
  const pairs = toolPairs(turn).filter(({ call }) => options.allTools || !REREADABLE_TOOLS.has(call.name))
  const heads = pairs.map(({ call, result }) => `${describeToolCall(call)}${result.is_error ? " (failed)" : ""}`)
  return render(resolved(options).ranked ? byScore(heads, pairs, options) : inCallOrder(heads, pairs, options))
}
