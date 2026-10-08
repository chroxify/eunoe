/**
 * Scores a run of the planted suite and writes runs/<tag>/report.md.
 *
 * The unit of analysis is the session: per-arm accuracy is computed per
 * session first, then compared to native session by session (paired), with a
 * bootstrap 95% interval over sessions. Facts within a session are not
 * independent draws, so they are never resampled on their own.
 *
 *   bun bench/plant/report.ts [--tag=main] [--split=dev|test|all]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { bucketOf, DEPTH_BUCKETS, type FactType } from "./facts"
import { loadMetas, RUNS, verdict, type ArmResult } from "./run"

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const pct = (x: number) => `${Math.round(x * 100)}%`
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

function bootstrap(diffs: number[], draws = 10_000) {
  let s = 12345
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const means: number[] = []
  for (let d = 0; d < draws; d += 1) {
    let sum = 0
    for (let i = 0; i < diffs.length; i += 1) sum += diffs[Math.floor(rand() * diffs.length)]
    means.push(sum / diffs.length)
  }
  means.sort((a, b) => a - b)
  return [means[Math.floor(draws * 0.025)], means[Math.floor(draws * 0.975)]]
}

export function report(tag: string, split: string) {
  const dir = path.join(RUNS, tag)
  const metas = loadMetas(split)
  const results = new Map<string, Map<string, ArmResult>>()
  const excluded: string[] = []
  for (const meta of metas) {
    for (const file of Array.from(new Bun.Glob(`${meta.id}.*.json`).scanSync({ cwd: dir }))) {
      const r = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as ArmResult
      const fact = (id: string) => meta.facts.find((f) => f.id === id)!
      r.recall = Object.fromEntries(Object.keys(r.recall).map((id) => [id, verdict(fact(id), r.answers?.[id])]))
      r.tasks = Object.fromEntries(Object.keys(r.tasks).map((id) => [id, verdict(fact(id), r.replies?.[id])]))
      if (!Object.keys(r.answers ?? {}).length) { excluded.push(`${r.arm} ${meta.id}: no answers (${(r.errors[0] ?? "no error recorded").slice(0, 120)})`); continue }
      if (!results.has(r.arm)) results.set(r.arm, new Map())
      results.get(r.arm)!.set(meta.id, r)
    }
  }
  const arms = [...results.keys()].sort((a, b) => (a === "native" ? -1 : b === "native" ? 1 : a.localeCompare(b)))
  const factsOf = new Map(metas.map((m) => [m.id, m.facts]))
  const sessionsFor = (arm: string) => metas.filter((m) => results.get(arm)?.has(m.id))
  const score = (arm: string, filter: (f: any) => boolean = () => true, part: "recall" | "tasks" = "recall") => {
    let n = 0
    const counts = { correct: 0, stale: 0, wrong: 0, unknown: 0 }
    for (const meta of sessionsFor(arm)) {
      const r = results.get(arm)!.get(meta.id)!
      for (const f of meta.facts.filter(filter)) {
        const v = r[part][f.id]
        if (!v) continue
        n += 1
        counts[v] += 1
      }
    }
    return { n, ...counts, acc: n ? counts.correct / n : NaN }
  }
  const perSession = (arm: string, part: "recall" | "tasks" = "recall") => new Map(sessionsFor(arm).map((m) => {
    const verdicts = Object.values(results.get(arm)!.get(m.id)![part])
    return [m.id, verdicts.length ? verdicts.filter((v) => v === "correct").length / verdicts.length : NaN]
  }))

  const out: string[] = []
  const types: FactType[] = ["tool_value", "prose_value", "error", "instruction", "revised", "superseded", "decision", "promise"]
  out.push(`# Planted-fact suite: ${tag} (${split})`, "")
  out.push(`${metas.length} sessions, ${metas.reduce((s, m) => s + m.facts.length, 0)} planted facts, answering model in every arm the same. Scored by exact match against the planted value; no judge.`, "")
  out.push("## Recall", "")
  out.push(`| arm | sessions | all | ${types.join(" | ")} | stale | unknown | wrong |`)
  out.push(`|---|---|---|${types.map(() => "---").join("|")}|---|---|---|`)
  for (const arm of arms) {
    const all = score(arm)
    out.push(`| ${arm} | ${sessionsFor(arm).length} | **${pct(all.acc)}** | ${types.map((t) => pct(score(arm, (f) => f.type === t).acc)).join(" | ")} | ${pct(all.stale / all.n)} | ${pct(all.unknown / all.n)} | ${pct(all.wrong / all.n)} |`)
  }
  out.push("", "### By depth (turns before the cut)", "")
  out.push(`| arm | ${DEPTH_BUCKETS.map(([b]) => b).join(" | ")} |`, `|---|${DEPTH_BUCKETS.map(() => "---").join("|")}|`)
  for (const arm of arms) out.push(`| ${arm} | ${DEPTH_BUCKETS.map(([b]) => pct(score(arm, (f) => bucketOf(f.ago) === b).acc)).join(" | ")} |`)

  out.push("", "## Applying instructions unprompted (tasks)", "")
  out.push("| arm | applied | stale (used the old rule) | missed |", "|---|---|---|---|")
  for (const arm of arms) {
    const t = score(arm, (f) => f.implicit, "tasks")
    out.push(`| ${arm} | **${pct(t.acc)}** | ${pct(t.stale / t.n)} | ${pct((t.wrong + t.unknown) / t.n)} |`)
  }

  if (arms.includes("native")) {
    out.push("", "## Against native (paired by session, 95% bootstrap interval)", "")
    out.push("| arm | recall Δ | tasks Δ | sessions better / worse |", "|---|---|---|---|")
    const base = perSession("native")
    const baseTasks = perSession("native", "tasks")
    for (const arm of arms.filter((a) => a !== "native")) {
      const mine = perSession(arm)
      const shared = [...mine.keys()].filter((k) => base.has(k))
      const diffs = shared.map((k) => mine.get(k)! - base.get(k)!)
      const mineTasks = perSession(arm, "tasks")
      const taskDiffs = shared.filter((k) => !Number.isNaN(mineTasks.get(k)!) && !Number.isNaN(baseTasks.get(k)!)).map((k) => mineTasks.get(k)! - baseTasks.get(k)!)
      const [lo, hi] = diffs.length > 1 ? bootstrap(diffs) : [NaN, NaN]
      const [tlo, thi] = taskDiffs.length > 1 ? bootstrap(taskDiffs) : [NaN, NaN]
      const f = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`
      out.push(`| ${arm} | ${f(mean(diffs))} [${f(lo)}, ${f(hi)}] | ${f(mean(taskDiffs))} [${f(tlo)}, ${f(thi)}] | ${diffs.filter((d) => d > 0).length} / ${diffs.filter((d) => d < 0).length} |`)
    }
  }

  out.push("", "## Cost and context", "")
  out.push("| arm | context at recall (median) | tokens processed / session | cache read | cache write | lookups / session | wall s |", "|---|---|---|---|---|---|---|")
  for (const arm of arms) {
    const rs = sessionsFor(arm).map((m) => results.get(arm)!.get(m.id)!)
    const median = (xs: number[]) => { const s = xs.filter((x) => x).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
    const k = (x: number) => `${Math.round(x / 1000)}k`
    out.push(`| ${arm} | ${k(median(rs.map((r) => r.contextAtRecall ?? 0)))} | ${k(mean(rs.map((r) => r.tokensProcessed)))} | ${k(mean(rs.map((r) => r.cacheRead)))} | ${k(mean(rs.map((r) => r.cacheWrite)))} | ${mean(rs.map((r) => r.lookups.calls)).toFixed(1)} | ${Math.round(mean(rs.map((r) => r.wallMs)) / 1000)} |`)
  }
  const errors = arms.flatMap((arm) => sessionsFor(arm).flatMap((m) => results.get(arm)!.get(m.id)!.errors.map((e) => `${arm} ${m.id}: ${e.slice(0, 120)}`)))
  if (excluded.length) out.push("", "## Excluded runs", "", "A run that returned no recall answers is a failed run, not a score of 0%. It is left out of that arm's numbers and of every paired comparison with it.", "", ...excluded.map((e) => `- ${e}`))
  if (errors.length) out.push("", "## Errors", "", ...errors.map((e) => `- ${e}`))
  const text = out.join("\n") + "\n"
  writeFileSync(path.join(dir, `report.${split}.md`), text)
  return text
}

if (import.meta.main) {
  const tag = arg("tag") ?? "main"
  if (!existsSync(path.join(RUNS, tag))) { console.error(`no runs/${tag}`); process.exit(1) }
  console.log(report(tag, arg("split") ?? "dev"))
}
