/**
 * Scores a tagged real-session run (bench/out/real/runs/<tag>/p*.json): recall per
 * arm as the mean of both judges' 0–2 grades, overall, by question type and by
 * depth, and paired against native by point with a bootstrap 95% interval.
 * Arithmetic only; no model is called.
 *
 *   bun bench/real/report.ts <tag>
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const tag = process.argv[2]
if (!tag) { console.error("usage: bun bench/real/report.ts <tag>"); process.exit(1) }
const dir = path.join(import.meta.dir, "..", "out", "real", "runs", tag)
const files = [...new Bun.Glob("p[0-9][0-9].json").scanSync({ cwd: dir, absolute: true })].sort()
const results = files.map((f) => JSON.parse(readFileSync(f, "utf8")))
const arms = [...new Set(results.flatMap((r) => Object.keys(r.labels)))]
const BUCKETS: Array<[string, (n: number) => boolean]> = [["0-3", (n) => n <= 3], ["4-10", (n) => n >= 4 && n <= 10], ["11-25", (n) => n >= 11 && n <= 25], ["26+", (n) => n >= 26]]

const grade = (r: any, arm: string, i: number) => {
  const per = r.judges.filter((j: string) => r.grades[j]?.[arm]).map((j: string) => r.grades[j][arm][i].score)
  return per.length ? per.reduce((a: number, b: number) => a + b, 0) / per.length / 2 : null
}
const rows = results.flatMap((r) => r.questions.map((q: any, i: number) => ({ point: r.tag, kind: r.kind, type: q.type, ago: q.turnsAgo ?? 0, scores: Object.fromEntries(arms.map((a) => [a, grade(r, a, i)])) })))
const pct = (xs: number[]) => (xs.length ? `${Math.round((100 * xs.reduce((a, b) => a + b, 0)) / xs.length)}%` : "–")
const of = (arm: string, keep: (row: any) => boolean = () => true) => rows.filter((row) => keep(row) && row.scores[arm] !== null).map((row) => row.scores[arm] as number)

function paired(arm: string, base = "native") {
  const per = results.map((r) => {
    const own = rows.filter((row) => row.point === r.tag && row.scores[arm] !== null && row.scores[base] !== null)
    return own.length ? own.reduce((s, row) => s + row.scores[arm] - row.scores[base], 0) / own.length : null
  }).filter((d): d is number => d !== null)
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  let seed = 20261008
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const boots = Array.from({ length: 20_000 }, () => mean(per.map(() => per[Math.floor(rand() * per.length)]))).sort((a, b) => a - b)
  const f = (x: number) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(1)}`
  return `${f(mean(per))} [${f(boots[500])}, ${f(boots[19_500])}] · ${per.filter((d) => d > 0).length} / ${per.filter((d) => d < 0).length}`
}

const types = [...new Set(rows.map((row) => row.type))]
const md = [
  `# Real-session suite: ${tag}`,
  "",
  `${results.length} points (${results.filter((r) => r.kind === "real").length} real, ${results.filter((r) => r.kind === "synthetic").length} synthetic), ${rows.length} vetted questions, answering model ${results[0]?.answerModel}, judges ${results[0]?.judges.join(" + ")}. Score = mean judge grade / 2.`,
  "",
  `| arm | recall | real only | ${types.join(" | ")} | ${BUCKETS.map(([b]) => `${b} turns ago`).join(" | ")} | vs native (Δ, 95% CI, points better / worse) |`,
  `|---|---|---|${types.map(() => "---").join("|")}|${BUCKETS.map(() => "---").join("|")}|---|`,
  ...arms.map((a) => `| ${a} | **${pct(of(a))}** | ${pct(of(a, (r) => r.kind === "real"))} | ${types.map((t) => pct(of(a, (r) => r.type === t))).join(" | ")} | ${BUCKETS.map(([, keep]) => pct(of(a, (r) => keep(r.ago)))).join(" | ")} | ${a === "native" ? "–" : paired(a)} |`),
]
writeFileSync(path.join(dir, "results.md"), md.join("\n") + "\n")
console.log(md.join("\n"))
