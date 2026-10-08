import { readFileSync } from "node:fs"
import path from "node:path"
import { splitTurns } from "../../src/context/turns"
import { sizeOf } from "../../src/proxy/estimate"
import { DEFAULT_RATIO } from "../../src/proxy/constants"
import type { Message } from "../../src/context/types"

const dir = path.join(import.meta.dir, "..", "out", "planted", "sessions")
const files = [...new Bun.Glob("s[0-9][0-9].jsonl").scanSync({ cwd: dir, absolute: true })].sort()
const budgets = [50_000, 100_000, 200_000, 300_000]
const keep = Number(process.argv[2] ?? 3)

function load(file: string): Message[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    const e = JSON.parse(line)
    return (e.type === "user" || e.type === "assistant") && e.message ? [e.message as Message] : []
  })
}

const rows: Record<number, { steps: number[]; gaps: number[]; live: number[] }> = Object.fromEntries(budgets.map((b) => [b, { steps: [], gaps: [], live: [] }]))
for (const file of files) {
  const { turns } = splitTurns(load(file))
  const size = (ts: Message[][]) => Math.round(sizeOf({ messages: ts.flat() } as any) * DEFAULT_RATIO)
  const total = size(turns)
  for (const budget of budgets) {
    let cut = 0
    let steps = 0
    let last = 0
    const gaps: number[] = []
    let maxLive = 0
    for (let current = keep + 1; current < turns.length; current += 1) {
      const next = current - keep
      const backlog = size(turns.slice(cut, next))
      const live = size(turns.slice(cut, current + 1))
      maxLive = Math.max(maxLive, live)
      if (next > cut && backlog > budget) {
        steps += 1
        gaps.push(current - last)
        last = current
        cut = next
      }
    }
    rows[budget].steps.push(steps)
    rows[budget].gaps.push(...gaps)
    rows[budget].live.push(maxLive)
  }
  console.error(`${path.basename(file)} ${turns.length} turns ~${Math.round(total / 1000)}k`)
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
console.log(`keep=${keep}, ${files.length} sessions`)
console.log("budget | steps/session (mean) | turns between steps (median, mean) | sessions with 0 steps | peak context (median)")
for (const b of budgets) {
  const r = rows[b]
  console.log(`${b / 1000}k | ${mean(r.steps).toFixed(1)} | ${med(r.gaps)}, ${mean(r.gaps).toFixed(1)} | ${r.steps.filter((s) => s === 0).length} | ${Math.round(med(r.live) / 1000)}k`)
}
