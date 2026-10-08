import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { resultText } from "../../src/context/content"
import { toolPairs, turnEvidence } from "../../src/context/evidence"
import type { EvidenceOptions, Message } from "../../src/context/types"
import { REREADABLE_TOOLS } from "../../src/context/constants"
import { COMPONENTS, Tally, TOOL_FACTS, depthBucket, keyTokens, mentions, pct, plantedSessions, realPoints } from "../lib/data"

const VARIANTS: Record<string, EvidenceOptions> = {
  v1: { linesPerCall: 4, turnChars: 1_600, scanLines: 400, minScore: 3, ranked: false, labels: false },
  default: {},
  wide: { linesPerCall: 8, turnChars: 3_200 },
  deep: { scanLines: 1_000_000 },
  loose: { minScore: 2 },
  alltools: { allTools: true },
  "wide+deep": { linesPerCall: 8, turnChars: 3_200, scanLines: 1_000_000 },
  "wide+deep+loose": { linesPerCall: 8, turnChars: 3_200, scanLines: 1_000_000, minScore: 2 },
  "wide+deep+alltools": { linesPerCall: 8, turnChars: 3_200, scanLines: 1_000_000, allTools: true },
  "xwide+deep": { linesPerCall: 12, turnChars: 6_000, scanLines: 1_000_000 },
  ranked: { ranked: true, linesPerCall: 8, turnChars: 3_200, scanLines: 1_000_000 },
  "ranked+labels": { ranked: true, labels: true, linesPerCall: 8, turnChars: 3_200, scanLines: 1_000_000 },
  "ranked+labels+loose": { ranked: true, labels: true, minScore: 2, linesPerCall: 8, turnChars: 3_200, scanLines: 1_000_000 },
  "ranked+labels+loose 2k": { ranked: true, labels: true, minScore: 2, linesPerCall: 8, turnChars: 2_000, scanLines: 1_000_000 },
  "ranked+labels+loose 12/4k": { ranked: true, labels: true, minScore: 2, linesPerCall: 12, turnChars: 4_000, scanLines: 1_000_000 },
  "floor0": { callFloor: 0 },
  "floor4": { callFloor: 4 },
  "default 3k": { turnChars: 3_000 },
  "default 6k": { turnChars: 6_000 },
}

function outputOf(turn: Message[], allTools: boolean): string {
  return toolPairs(turn).filter(({ call }) => allTools || !REREADABLE_TOOLS.has(call.name)).map(({ result }) => resultText(result)).join("\n")
}

const split = process.argv[2]
const sessions = plantedSessions(split)
const real = realPoints()
const names = Object.keys(VARIANTS)

const byType = new Map(names.map((n) => [n, new Tally()]))
const byDepth = new Map(names.map((n) => [n, new Tally()]))
const cost = new Map(names.map((n) => [n, { evidence: 0, output: 0, turns: 0, sizes: [] as number[] }]))
let placed = 0
let inOutput = 0

for (const session of sessions) {
  for (const turn of session.turns) {
    for (const name of names) {
      const c = cost.get(name)!
      const text = turnEvidence(turn, VARIANTS[name]) ?? ""
      c.evidence += text.length
      c.output += outputOf(turn, Boolean(VARIANTS[name].allTools)).length
      c.turns += 1
      c.sizes.push(text.length)
    }
  }
  for (const fact of session.facts) {
    if (!TOOL_FACTS.has(fact.type)) continue
    for (const plant of fact.plants) {
      const turn = session.turns[plant.turn - 1]
      if (!turn) continue
      placed += 1
      const present = outputOf(turn, true).includes(plant.value)
      if (!present) continue
      inOutput += 1
      const label = fact.type === "superseded" ? (plant.value === fact.answer ? "superseded (current)" : "superseded (stale)") : fact.type
      for (const name of names) {
        const hit = (turnEvidence(turn, VARIANTS[name]) ?? "").includes(plant.value)
        byType.get(name)!.add(label, hit)
        byType.get(name)!.add("all", hit)
        byDepth.get(name)!.add(depthBucket(fact.ago), hit)
      }
    }
  }
}

const realTally = new Map(names.map((n) => [n, new Tally()]))
let realAsked = 0
let realInOutput = 0
for (const point of real) {
  for (const q of point.questions) {
    if (q.type !== "tool_evidence" && q.type !== "recent") continue
    realAsked += 1
    const tokens = keyTokens(q.answer)
    const centre = point.turns.length - q.turnsAgo
    const near = point.turns.slice(Math.max(0, centre - 1), centre + 2)
    if (!near.length || !near.some((t) => mentions(outputOf(t, true), tokens))) continue
    realInOutput += 1
    for (const name of names) {
      const hit = near.some((t) => mentions(turnEvidence(t, VARIANTS[name]) ?? "", tokens))
      realTally.get(name)!.add(q.type, hit)
      realTally.get(name)!.add("all", hit)
    }
  }
}

const typeKeys = ["tool_value", "error", "prose_value", "superseded (current)", "superseded (stale)", "all"]
const depthKeys = ["1–3", "4–10", "11–30", "31–60", "61+"]
const lines: string[] = []
lines.push(`# Evidence coverage${split ? ` (${split} split)` : ""}`, "")
lines.push(`Planted facts placed in tool output: ${placed}; found in that turn's output: ${inOutput} (${pct(inOutput, placed)}). Sessions: ${sessions.length}.`, "")
lines.push("## Coverage by fact type (planted)", "")
lines.push(`| variant | ${typeKeys.join(" | ")} |`, `|${"---|".repeat(typeKeys.length + 1)}`)
for (const name of names) lines.push(`| ${name} | ${typeKeys.map((k) => byType.get(name)!.get(k)).join(" | ")} |`)
lines.push("", "## Coverage by distance from the cut (planted)", "")
lines.push(`| variant | ${depthKeys.join(" | ")} |`, `|${"---|".repeat(depthKeys.length + 1)}`)
for (const name of names) lines.push(`| ${name} | ${depthKeys.map((k) => byDepth.get(name)!.get(k)).join(" | ")} |`)
lines.push("", "## Cost (every turn of every session)", "")
lines.push("| variant | evidence chars / turn (mean) | p95 | share of eligible output kept |", "|---|---|---|---|")
for (const name of names) {
  const c = cost.get(name)!
  const sorted = [...c.sizes].sort((a, b) => a - b)
  lines.push(`| ${name} | ${Math.round(c.evidence / Math.max(1, c.turns))} | ${sorted[Math.floor(sorted.length * 0.95)] ?? 0} | ${(100 * c.evidence / Math.max(1, c.output)).toFixed(1)}% |`)
}
lines.push("", `## Real sessions (tool_evidence + recent questions)`, "")
lines.push(`Questions: ${realAsked}; answer tokens found in the source turn's output (±1 turn): ${realInOutput}. Hit = any answer token survives in evidence.`, "")
lines.push("| variant | tool_evidence | recent | all |", "|---|---|---|---|")
for (const name of names) lines.push(`| ${name} | ${realTally.get(name)!.get("tool_evidence")} | ${realTally.get(name)!.get("recent")} | ${realTally.get(name)!.get("all")} |`)
mkdirSync(COMPONENTS, { recursive: true })
const out = path.join(COMPONENTS, `evidence${split ? `.${split}` : ""}.md`)
writeFileSync(out, lines.join("\n") + "\n")
console.log(lines.join("\n"))
console.log(`\nwritten ${out}`)
