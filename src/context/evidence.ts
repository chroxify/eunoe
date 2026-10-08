import { ERROR_CODE, ERROR_LINE, EVIDENCE_CALL_FLOOR, EVIDENCE_LABELS, EVIDENCE_LINE_CHARS, EVIDENCE_LINES_PER_CALL, EVIDENCE_MIN_SCORE, EVIDENCE_RANKED, EVIDENCE_SCAN_LINES, EVIDENCE_TURN_CHARS, ID_TOKEN, KEY_VALUE, REREADABLE_TOOLS, VALUE_LABEL, VALUE_TOKEN } from "./constants"
import { blocks, clip, describeToolCall, resultText } from "./content"
import type { Block, EvidenceOptions, Message } from "./types"

interface Scored {
  index: number
  line: string
  score: number
}

export function isSalient(line: string): boolean {
  return ERROR_LINE.test(line) || ERROR_CODE.test(line) || VALUE_TOKEN.test(line)
}

function scoreLines(text: string, options: EvidenceOptions): Scored[] {
  const scan = options.scanLines ?? EVIDENCE_SCAN_LINES
  const lineChars = options.lineChars ?? EVIDENCE_LINE_CHARS
  const minScore = options.minScore ?? EVIDENCE_MIN_SCORE
  const scored = text.split("\n").slice(0, scan).flatMap((raw, index) => {
    const line = raw.trim()
    if (line.length < 4) return []
    const error = ERROR_LINE.test(line) || ERROR_CODE.test(line)
    const value = VALUE_TOKEN.test(line)
    if (!error && !value) return []
    const score = (error ? 3 : 0) + (value ? (ID_TOKEN.test(line) ? 3 : 2) : 0) + (KEY_VALUE.test(line) ? 1 : 0) + (line.length < 120 ? 1 : 0) + ((options.labels ?? EVIDENCE_LABELS) && VALUE_LABEL.test(line) ? 1 : 0)
    return score >= minScore ? [{ index, line: clip(line, lineChars), score }] : []
  })
  const seen = new Set<string>()
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).filter((s) => !seen.has(s.line) && seen.add(s.line))
}

export function salientLines(text: string, options: EvidenceOptions = {}): string[] {
  return scoreLines(text, options)
    .slice(0, options.linesPerCall ?? EVIDENCE_LINES_PER_CALL)
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
    .flatMap((call) => (results.has(call.id) ? [{ call, result: results.get(call.id)! }] : []))
}

function render(entries: Array<{ head: string; lines: string[] }>): string | null {
  const body = entries.filter((e) => e.lines.length).map((e) => `- ${e.head}:\n${e.lines.map((l) => `    ${l}`).join("\n")}`)
  return body.length ? `<tool-evidence>\nKey lines of command output from this turn, kept verbatim (the full output is in the transcript):\n${body.join("\n")}\n</tool-evidence>` : null
}

export function turnEvidence(turn: Message[], options: EvidenceOptions = {}): string | null {
  const turnChars = options.turnChars ?? EVIDENCE_TURN_CHARS
  const perCall = options.linesPerCall ?? EVIDENCE_LINES_PER_CALL
  const pairs = toolPairs(turn).filter(({ call }) => options.allTools || !REREADABLE_TOOLS.has(call.name))
  const heads = pairs.map(({ call, result }) => `${describeToolCall(call)}${result.is_error ? " (failed)" : ""}`)
  if (!(options.ranked ?? EVIDENCE_RANKED)) {
    const entries: Array<{ head: string; lines: string[] }> = []
    let used = 0
    pairs.forEach(({ result }, i) => {
      const lines = salientLines(resultText(result), options)
      if (!lines.length) return
      const size = heads[i].length + 4 + lines.reduce((s, l) => s + l.length + 5, 0)
      if (used + size > turnChars) return
      entries.push({ head: heads[i], lines })
      used += size
    })
    return render(entries)
  }
  const floor = options.callFloor ?? EVIDENCE_CALL_FLOOR
  const perCallLines = pairs.map(({ result }) => scoreLines(resultText(result), options))
  const chosen = new Map<number, Scored[]>()
  let used = 0
  const take = (call: number, line: Scored) => {
    const bucket = chosen.get(call) ?? []
    const cost = line.line.length + 5 + (bucket.length ? 0 : heads[call].length + 4)
    if (bucket.length >= perCall || used + cost > turnChars) return
    bucket.push(line)
    chosen.set(call, bucket)
    used += cost
  }
  perCallLines.forEach((lines, call) => lines.slice(0, floor).forEach((line) => take(call, line)))
  perCallLines
    .flatMap((lines, call) => lines.slice(floor).map((line) => ({ line, call })))
    .sort((a, b) => b.line.score - a.line.score || a.call - b.call || a.line.index - b.line.index)
    .forEach(({ line, call }) => take(call, line))
  return render(heads.map((head, i) => ({ head, lines: (chosen.get(i) ?? []).sort((a, b) => a.index - b.index).map((s) => s.line) })))
}
