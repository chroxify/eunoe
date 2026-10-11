import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { loadMetas } from "../planted/run"
import { BASELINE_ARMS, REPORT_SCENARIOS, RUNS } from "./constants"

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const tag = arg("tag") ?? "agent-dev"
const split = arg("split") ?? "dev"
const baseline = arg("baseline") ?? split

const metas = loadMetas(split)
const ids = new Set(metas.map((m) => m.id))
const read = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json") && ids.has(f.split(".")[0]))
        .map((f) => ({ ...JSON.parse(readFileSync(path.join(dir, f), "utf8")), source: f.split(".")[0] }))
    : []
const results = [...read(path.join(RUNS, tag)), ...read(path.join(RUNS, baseline)).filter((r) => BASELINE_ARMS.includes(r.arm))]

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–")
const share = (rows: any[], key: "recall" | "tasks") => {
  const v = rows.flatMap((r) => Object.values(r[key] ?? {}) as string[])
  return pct(v.filter((x) => x === "correct").length, v.length)
}
const sourceOf = (call: string) => call.match(/eunoe\s+(?:load|peek)\s+"?(s\d+)/)?.[1]
const median = (xs: number[]) => (xs.length > 0 ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0)
const k = (n: number) => `${Math.round(n / 1000)}k`

const arms = [...new Set(results.map((r) => r.arm))]
const lines = [`# Agent-controlled handoff: ${tag} (${split}, ${metas.length} sessions)`, ""]
lines.push(
  "Facts and rules are scored exactly as in the handoff suite. *Pulled* is the share of fresh sessions where the agent ran `eunoe load` or `eunoe peek` at all; *right* is the share where every session it loaded or peeked was the source. In `new` the work is unrelated, so any pull is unnecessary.",
  "",
)
for (const scenario of REPORT_SCENARIOS) {
  const rows = results.filter((r) => r.scenario === scenario)
  if (rows.length === 0) continue
  lines.push(`## ${scenario}`, "", "| arm | runs | facts | rules | pulled | loaded | right session | commands / run | tokens / run | wall s |", "|---|---|---|---|---|---|---|---|---|---|")
  for (const arm of arms) {
    const mine = rows.filter((r) => r.arm === arm)
    if (mine.length === 0) continue
    const agent = mine.some((r) => r.agentCalls)
    const pulls: string[][] = mine.map((r) => (r.agentCalls ?? []).filter((c: string) => /eunoe\s+(load|peek)\b/.test(c)))
    const pulled = pulls.filter((p) => p.length).length
    const loaded = mine.filter((r) => (r.agentCalls ?? []).some((c: string) => /eunoe\s+load\b/.test(c))).length
    const right = pulls.filter((p, i) => p.length > 0 && p.every((c) => sourceOf(c) === mine[i].source)).length
    const commands = mine.reduce((s, r) => s + (r.agentCalls?.length ?? 0), 0) / mine.length
    lines.push(
      `| ${arm} | ${mine.length} | ${scenario === "new" ? "–" : share(mine, "recall")} | ${scenario === "new" ? "–" : share(mine, "tasks")} | ${agent ? pct(pulled, mine.length) : "–"} | ${agent ? pct(loaded, mine.length) : "–"} | ${agent ? pct(right, pulled) : "–"} | ${agent ? commands.toFixed(1) : "–"} | ${k(median(mine.map((r) => r.tokensProcessed ?? 0)))} | ${Math.round(median(mine.map((r) => r.wallMs ?? 0)) / 1000)} |`,
    )
  }
  lines.push("")
}

const out = path.join(RUNS, tag, `report.${split}.md`)
writeFileSync(out, lines.join("\n"))
console.log(lines.join("\n"))
