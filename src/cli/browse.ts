import { BROWSE_DEFAULT_COLUMNS, BROWSE_MIN_COLUMNS, BROWSE_ROWS, KEY_BACKSPACE, KEY_CLEAR, KEY_DOWN, KEY_ENTER, KEY_ESCAPE, KEY_UP, UNTITLED } from "./constants"
import { keys } from "./prompt"
import { rankCandidates, type SessionCandidate } from "./session-source"
import { askOf, shortId, tokensOf } from "./sessions"
import { ago, c, useColor } from "./ui"

const columns = () => Math.max(BROWSE_MIN_COLUMNS, process.stdout.columns ?? BROWSE_DEFAULT_COLUMNS)
const clip = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text)

export function filterCandidates(query: string, candidates: SessionCandidate[]): SessionCandidate[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return candidates
  const ranked = rankCandidates(query, candidates)
  const haystack = (cand: SessionCandidate) => `${cand.label} ${cand.asks.join(" ")} ${cand.id}`.toLowerCase()
  const loose = candidates.filter((cand) => !ranked.includes(cand) && words.every((word) => haystack(cand).includes(word)))
  return [...ranked, ...loose]
}

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let current = ""
  for (const word of text.split(" ")) {
    if (current && current.length + 1 + word.length > width) {
      out.push(current)
      current = word
    } else current = current ? `${current} ${word}` : word
  }
  if (current) out.push(current)
  return out
}

const metas = new Map<string, string>()
const meta = (cand: SessionCandidate) => {
  const cached = metas.get(cand.id) ?? `${cand.asks.length} turns · ~${tokensOf(cand)} tokens · ${ago(new Date(cand.mtime).toISOString())}`
  metas.set(cand.id, cached)
  return cached
}

function row(cand: SessionCandidate, chosen: boolean, width: number): string[] {
  const marker = chosen ? c.green("●") : c.dim("○")
  const info = meta(cand)
  const title = cand.label ? clip(cand.label, width - info.length - 16) : UNTITLED
  const head = `  ${marker} ${c.cyan(shortId(cand.id))}  ${chosen ? c.bold(title) : cand.label ? title : c.dim(title)}  ${c.dim(info)}`
  if (!chosen) return [head]
  const lines = [head]
  for (const [label, text] of [["first", cand.asks[0]], ["last ", cand.asks.at(-1)]] as const) {
    const [first = "", ...rest] = wrap(askOf(text), width - 14)
    lines.push(`      ${c.dim(label)}  ${first}`, ...rest.map((more) => `             ${more}`))
  }
  return lines
}

function render(title: string, query: string, shown: SessionCandidate[], total: number, index: number, help: string): string[] {
  const width = columns()
  const lines = [`  ${c.bold(title)}  ${c.dim(`${shown.length} of ${total}`)}`, `  ${c.cyan("›")} ${query || c.dim("type to filter")}`, ""]
  if (!shown.length) lines.push(`  ${c.dim("nothing matches")}`)
  const start = Math.max(0, Math.min(index - Math.floor(BROWSE_ROWS / 2), shown.length - BROWSE_ROWS))
  const window = shown.slice(start, start + BROWSE_ROWS)
  if (start > 0) lines.push(`  ${c.dim(`↑ ${start} more`)}`)
  for (const [i, cand] of window.entries()) lines.push(...row(cand, start + i === index, width))
  if (start + BROWSE_ROWS < shown.length) lines.push(`  ${c.dim(`↓ ${shown.length - start - BROWSE_ROWS} more`)}`)
  lines.push("", `  ${c.dim(help)}`)
  return lines
}

export async function browse(title: string, candidates: SessionCandidate[], initial = "", help = "↑↓ move · type to filter · enter choose · esc quit"): Promise<SessionCandidate | null> {
  let query = initial
  let shown = filterCandidates(query, candidates)
  let index = 0
  let drawn = 0
  const draw = () => {
    const lines = render(title, query, shown, candidates.length, index, help)
    if (drawn) process.stdout.write(`\x1b[${drawn}A\x1b[J`)
    process.stdout.write(lines.join("\n") + "\n")
    drawn = lines.length
  }
  let chosen: SessionCandidate | null = null
  process.stdout.write(useColor ? "\x1b[?25l" : "")
  draw()
  await keys((key) => {
    if (key === KEY_UP) index = shown.length ? (index + shown.length - 1) % shown.length : 0
    else if (key === KEY_DOWN) index = shown.length ? (index + 1) % shown.length : 0
    else if (KEY_ENTER.includes(key)) {
      chosen = shown[index] ?? null
      return true
    } else if (KEY_ESCAPE.includes(key)) return true
    else {
      if (KEY_BACKSPACE.includes(key)) query = query.slice(0, -1)
      else if (key === KEY_CLEAR) query = ""
      else if (key >= " " && !key.startsWith("\x1b")) query += key
      else return
      shown = filterCandidates(query, candidates)
      index = 0
    }
    draw()
  })
  process.stdout.write(`\x1b[${drawn}A\x1b[J`)
  process.stdout.write(useColor ? "\x1b[?25h" : "")
  return chosen
}
