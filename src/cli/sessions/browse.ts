import { clip } from "../../context/content"
import { interact, keys, printable } from "../terminal/prompt"
import { c, wrap } from "../terminal/ui"
import { askOf, metaOf, shortId } from "."
import { rankCandidates, type SessionCandidate } from "./source"

export const UNTITLED = "untitled"

const ROWS = 7

const metas = new Map<string, string>()

const columns = () => Math.max(60, process.stdout.columns ?? 100)

function cachedMeta(cand: SessionCandidate) {
  const meta = metas.get(cand.id) ?? metaOf(cand)
  metas.set(cand.id, meta)
  return meta
}

export function filterCandidates(query: string, candidates: SessionCandidate[]): SessionCandidate[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return candidates
  const ranked = rankCandidates(query, candidates)
  const haystack = (cand: SessionCandidate) => `${cand.label} ${cand.asks.join(" ")} ${cand.id}`.toLowerCase()
  const loose = candidates.filter((cand) => !ranked.includes(cand) && words.every((word) => haystack(cand).includes(word)))
  return [...ranked, ...loose]
}

function row(cand: SessionCandidate, chosen: boolean, width: number): string[] {
  const marker = chosen ? c.green("●") : c.dim("○")
  const info = cachedMeta(cand)
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
  const start = Math.max(0, Math.min(index - Math.floor(ROWS / 2), shown.length - ROWS))
  if (start > 0) lines.push(`  ${c.dim(`↑ ${start} more`)}`)
  for (const [i, cand] of shown.slice(start, start + ROWS).entries()) lines.push(...row(cand, start + i === index, width))
  if (start + ROWS < shown.length) lines.push(`  ${c.dim(`↓ ${shown.length - start - ROWS} more`)}`)
  lines.push("", `  ${c.dim(help)}`)
  return lines
}

export async function browse(title: string, candidates: SessionCandidate[], initial = "", help = "↑↓ move · type to filter · enter choose · esc quit"): Promise<SessionCandidate | null> {
  let query = initial
  let shown = filterCandidates(query, candidates)
  let index = 0
  let chosen: SessionCandidate | null = null
  const step = (by: number) => {
    index = shown.length > 0 ? (index + shown.length + by) % shown.length : 0
  }
  await interact(
    () => render(title, query, shown, candidates.length, index, help),
    (key) => {
      if (key === keys.up || key === keys.down) {
        step(key === keys.up ? -1 : 1)
        return
      }
      if (keys.enter.includes(key)) {
        chosen = shown[index] ?? null
        return true
      }
      if (keys.escape.includes(key)) return true
      if (keys.backspace.includes(key)) query = query.slice(0, -1)
      else if (key === keys.clear) query = ""
      else if (printable(key)) query += key
      else return
      shown = filterCandidates(query, candidates)
      index = 0
    },
  )
  return chosen
}
