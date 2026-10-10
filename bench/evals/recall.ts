import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { rank, recallChunks, recallFor, terms } from "../../src/context/recall"
import { Tally, depthBucket, keyTokens, mentions, pct, plantedSessions, realPoints } from "../lib/data"
import { COMPONENTS, TOOL_FACTS } from "../lib/constants"
import { DEPTH_KEYS, PLANTED_KEYS, REAL_KEYS, RECALL_VARIANTS } from "./constants"

const split = process.argv[2]
const sessions = plantedSessions(split)
const real = realPoints()
const names = Object.keys(RECALL_VARIANTS)

const byType = new Map(names.map((n) => [n, new Tally()]))
const byDepth = new Map(names.map((n) => [n, new Tally()]))
const ranks = new Map(names.map((n) => [n, [] as number[]]))
const sizes = new Map(names.map((n) => [n, [] as number[]]))
const staleOnly = new Map(names.map((n) => [n, 0]))
let asked = 0
let retrievable = 0

for (const session of sessions) {
  const all = [...session.messages, { role: "user", content: "" }]
  const chunksFor = new Map(names.map((n) => [n, recallChunks(all, new Map(), RECALL_VARIANTS[n])]))
  for (const fact of session.facts) {
    if (!TOOL_FACTS.has(fact.type)) continue
    asked += 1
    const chunks = chunksFor.get("default")!
    if (!chunks.some((c) => c.lines.join("\n").includes(fact.answer))) continue
    retrievable += 1
    for (const name of names) {
      const cs = chunksFor.get(name)!
      const injected = recallFor(fact.question, cs, RECALL_VARIANTS[name]) ?? ""
      const hit = injected.includes(fact.answer)
      byType.get(name)!.add(fact.type, hit)
      byType.get(name)!.add("all", hit)
      byDepth.get(name)!.add(depthBucket(fact.ago), hit)
      sizes.get(name)!.push(injected.length)
      if (!hit && fact.stale && injected.includes(fact.stale)) staleOnly.set(name, staleOnly.get(name)! + 1)
      const ranked = rank(terms(fact.question), cs, RECALL_VARIANTS[name].minTerms)
      const at = ranked.findIndex((r) => cs[r.index].lines.join("\n").includes(fact.answer))
      ranks.get(name)!.push(at < 0 ? 999 : at + 1)
    }
  }
}

const realTally = new Map(names.map((n) => [n, new Tally()]))
let realAsked = 0
let realRetrievable = 0
for (const point of real) {
  const all = [...point.messages, { role: "user", content: "" }]
  const chunksFor = new Map(names.map((n) => [n, recallChunks(all, new Map(), RECALL_VARIANTS[n])]))
  for (const q of point.questions) {
    if (q.type === "continuation") continue
    realAsked += 1
    const tokens = keyTokens(q.answer)
    if (!chunksFor.get("default")!.some((c) => mentions(c.lines.join("\n"), tokens))) continue
    realRetrievable += 1
    for (const name of names) {
      const injected = recallFor(q.question, chunksFor.get(name)!, RECALL_VARIANTS[name]) ?? ""
      const hit = mentions(injected, tokens)
      realTally.get(name)!.add(q.type, hit)
      realTally.get(name)!.add("all", hit)
    }
  }
}

const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
const lines: string[] = []
lines.push(`# Recall retrieval${split ? ` (${split} split)` : ""}`, "")
lines.push(`Planted tool-output facts: ${asked}; present in some chunk: ${retrievable} (${pct(retrievable, asked)}). Hit = the value is inside the injected <recalled-context> for the fact's own question. Sessions: ${sessions.length}.`, "")
lines.push("## Hit rate by fact type (planted)", "")
lines.push(`| variant | ${PLANTED_KEYS.join(" | ")} | median rank of first hit chunk | injected chars (median) | stale-only |`, `|${"---|".repeat(PLANTED_KEYS.length + 4)}`)
for (const name of names) lines.push(`| ${name} | ${PLANTED_KEYS.map((k) => byType.get(name)!.get(k)).join(" | ")} | ${med(ranks.get(name)!)} | ${med(sizes.get(name)!)} | ${staleOnly.get(name)} |`)
lines.push("", "## Hit rate by distance from the cut (planted)", "")
lines.push(`| variant | ${DEPTH_KEYS.join(" | ")} |`, `|${"---|".repeat(DEPTH_KEYS.length + 1)}`)
for (const name of names) lines.push(`| ${name} | ${DEPTH_KEYS.map((k) => byDepth.get(name)!.get(k)).join(" | ")} |`)
lines.push("", "## Real sessions (LLM-written questions)", "")
lines.push(`Questions: ${realAsked}; an answer token appears in some chunk (output or agent text): ${realRetrievable}. Hit = any answer token inside the injected context.`, "")
lines.push(`| variant | ${REAL_KEYS.join(" | ")} |`, `|${"---|".repeat(REAL_KEYS.length + 1)}`)
for (const name of names) lines.push(`| ${name} | ${REAL_KEYS.map((k) => realTally.get(name)!.get(k)).join(" | ")} |`)
mkdirSync(COMPONENTS, { recursive: true })
const out = path.join(COMPONENTS, `recall${split ? `.${split}` : ""}.md`)
writeFileSync(out, lines.join("\n") + "\n")
console.log(lines.join("\n"))
console.log(`\nwritten ${out}`)
