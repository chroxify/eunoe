import { clip } from "../../context/content"
import { KEY_BACKSPACE, KEY_CLEAR, KEY_DOWN, KEY_ENTER, KEY_ESCAPE, KEY_UP } from "../terminal/constants"
import { interact, printable } from "../terminal/prompt"
import { ago, c, wrap } from "../terminal/ui"
import { askOf, shortId, tokensOf } from "."
import { BROWSE_DEFAULT_COLUMNS, BROWSE_MIN_COLUMNS, BROWSE_ROWS, UNTITLED } from "./constants"
import { rankCandidates } from "./source"
import type { SessionCandidate } from "./types"

const columns = () => Math.max(BROWSE_MIN_COLUMNS, process.stdout.columns ?? BROWSE_DEFAULT_COLUMNS)

export function filterCandidates(query: string, candidates: SessionCandidate[]): SessionCandidate[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return candidates
  const ranked = rankCandidates(query, candidates)
  const haystack = (cand: SessionCandidate) => `${cand.label} ${cand.asks.join(" ")} ${cand.id}`.toLowerCase()
  const loose = candidates.filter((cand) => !ranked.includes(cand) && words.every((word) => haystack(cand).includes(word)))
  return [...ranked, ...loose]
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
  for (const [label, text] of [
    ["first", cand.asks[0]],
    ["last ", cand.asks.at(-1)],
  ] as const) {
    const [first = "", ...rest] = wrap(askOf(text), width - 14)
    lines.push(`      ${c.dim(label)}  ${first}`, ...rest.map((more) => `             ${more}`))
  }
  return lines
}

function render(title: string, query: string, shown: SessionCandidate[], total: number, index: number, help: string): string[] {
  const width = columns()
  const lines = [`  ${c.bold(title)}  ${c.dim(`${shown.length} of ${total}`)}`, `  ${c.cyan("›")} ${query || c.dim("type to filter")}`, ""]
  if (shown.length === 0) lines.push(`  ${c.dim("nothing matches")}`)
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
  let chosen: SessionCandidate | null = null
  await interact(
    () => render(title, query, shown, candidates.length, index, help),
    (key) => {
      if (key === KEY_UP) {
        index = shown.length > 0 ? (index + shown.length - 1) % shown.length : 0
        return
      }
      if (key === KEY_DOWN) {
        index = shown.length > 0 ? (index + 1) % shown.length : 0
        return
      }
      if (KEY_ENTER.includes(key)) {
        chosen = shown[index] ?? null
        return true
      }
      if (KEY_ESCAPE.includes(key)) return true
      if (KEY_BACKSPACE.includes(key)) query = query.slice(0, -1)
      else if (key === KEY_CLEAR) query = ""
      else if (printable(key)) query += key
      else return
      shown = filterCandidates(query, candidates)
      index = 0
    },
  )
  return chosen
}
