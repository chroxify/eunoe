import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { loadMetas } from "../planted/run"
import { HANDOFF_ARMS, RUNS, SCENARIOS } from "./constants"
import type { HandoffResult } from "./run"

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const tag = arg("tag") ?? "main"
const split = arg("split") ?? "dev"
const dir = path.join(RUNS, tag)

function bootstrap(diffs: number[], draws = 10_000) {
  let s = 12345
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  const means: number[] = []
  for (let d = 0; d < draws; d += 1) {
    let sum = 0
    for (let i = 0; i < diffs.length; i += 1) sum += diffs[Math.floor(rand() * diffs.length)]
    means.push(sum / diffs.length)
  }
  means.sort((a, b) => a - b)
  return [means[Math.floor(draws * 0.025)], means[Math.floor(draws * 0.975)]]
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–")
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length > 0 ? s[Math.floor(s.length / 2)] : 0
}

const metas = loadMetas(split)
const results = new Map<string, HandoffResult>()
for (const meta of metas)
  for (const scenario of SCENARIOS)
    for (const arm of HANDOFF_ARMS) {
      const file = path.join(dir, `${meta.id}.${scenario}.${arm.name}.json`)
      if (existsSync(file)) results.set(`${meta.id}.${scenario}.${arm.name}`, JSON.parse(readFileSync(file, "utf8")))
    }

const score = (r: HandoffResult) => {
  const facts = Object.values(r.recall)
  const tasks = Object.values(r.tasks)
  return {
    facts: facts.filter((v) => v === "correct").length / Math.max(1, facts.length),
    tasks: tasks.length > 0 ? tasks.filter((v) => v === "correct").length / tasks.length : null,
    unknown: facts.filter((v) => v === "unknown").length,
    wrong: facts.filter((v) => v === "wrong" || v === "stale").length,
    n: facts.length,
  }
}

const lines: string[] = []
lines.push(`# Handoff: ${tag} (${split})`, "")
lines.push(`${metas.length} source sessions × ${SCENARIOS.length} scenarios. A fresh session, one resume prompt, then the source session's tasks and recall questions. Scores are per fresh session, averaged.`, "")

const armsSeen = HANDOFF_ARMS.filter((a) => metas.some((m) => SCENARIOS.some((s) => results.has(`${m.id}.${s}.${a.name}`))))
lines.push("## By arm", "", "| arm | runs | facts remembered | rules applied | unknown | wrong | prompt at tasks | tokens per run | lookups | opening s | injected chars |", "|---|---|---|---|---|---|---|---|---|---|---|")
const armRows: Record<string, { facts: number[]; tasks: number[]; ctx: number[]; tokens: number[]; lookups: number[]; opening: number[]; injected: number[]; unknown: number; wrong: number; n: number }> = {}
for (const arm of armsSeen) {
  const rs = [...results.values()].filter((r) => r.arm === arm.name)
  const row = { facts: [] as number[], tasks: [] as number[], ctx: [] as number[], tokens: [] as number[], lookups: [] as number[], opening: [] as number[], injected: [] as number[], unknown: 0, wrong: 0, n: 0 }
  for (const r of rs) {
    const s = score(r)
    row.facts.push(s.facts)
    if (s.tasks !== null) row.tasks.push(s.tasks)
    if (r.contextAtTasks) row.ctx.push(r.contextAtTasks)
    row.tokens.push(r.tokensProcessed)
    row.lookups.push(r.lookups?.calls ?? 0)
    row.opening.push(r.openingMs / 1000)
    row.injected.push(r.injectedChars)
    row.unknown += s.unknown
    row.wrong += s.wrong
    row.n += s.n
  }
  armRows[arm.name] = row
  const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  lines.push(
    `| ${arm.name} | ${rs.length} | **${pct(mean(row.facts) * 100, 100)}** | ${row.tasks.length > 0 ? pct(mean(row.tasks) * 100, 100) : "–"} | ${pct(row.unknown, row.n)} | ${pct(row.wrong, row.n)} | ${k(median(row.ctx))} | ${k(mean(row.tokens))} | ${mean(row.lookups).toFixed(1)} | ${median(row.opening).toFixed(0)} | ${k(median(row.injected))} |`,
  )
}

lines.push("", "## By scenario (facts remembered)", "", `| arm | ${SCENARIOS.join(" | ")} |`, `|---|${SCENARIOS.map(() => "---").join("|")}|`)
for (const arm of armsSeen) {
  const cells = SCENARIOS.map((sc) => {
    const rs = [...results.values()].filter((r) => r.arm === arm.name && r.scenario === sc)
    return rs.length > 0 ? pct(rs.reduce((s, r) => s + score(r).facts, 0) * 100, rs.length * 100) : "–"
  })
  lines.push(`| ${arm.name} | ${cells.join(" | ")} |`)
}

lines.push("", "## By fact type (facts remembered)", "")
const types = [...new Set(metas.flatMap((m) => m.facts.map((f) => f.type)))]
lines.push(`| arm | ${types.join(" | ")} |`, `|---|${types.map(() => "---").join("|")}|`)
for (const arm of armsSeen) {
  const cells = types.map((t) => {
    let hit = 0
    let n = 0
    for (const meta of metas)
      for (const sc of SCENARIOS) {
        const r = results.get(`${meta.id}.${sc}.${arm.name}`)
        if (!r) continue
        for (const f of meta.facts.filter((fact) => fact.type === t)) {
          n += 1
          if (r.recall[f.id] === "correct") hit += 1
        }
      }
    return pct(hit, n)
  })
  lines.push(`| ${arm.name} | ${cells.join(" | ")} |`)
}

function paired(a: string, b: string, pick: (r: HandoffResult) => number | null) {
  const diffs: number[] = []
  for (const meta of metas)
    for (const sc of SCENARIOS) {
      const ra = results.get(`${meta.id}.${sc}.${a}`)
      const rb = results.get(`${meta.id}.${sc}.${b}`)
      if (!ra || !rb) continue
      const x = pick(ra)
      const y = pick(rb)
      if (x === null || y === null) continue
      diffs.push((x - y) * 100)
    }
  if (diffs.length === 0) return null
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length
  const [lo, hi] = bootstrap(diffs)
  return { mean, lo, hi, n: diffs.length, better: diffs.filter((d) => d > 0).length, worse: diffs.filter((d) => d < 0).length }
}
const fmt = (p: ReturnType<typeof paired>) => (p ? `${p.mean >= 0 ? "+" : ""}${p.mean.toFixed(1)} [${p.lo >= 0 ? "+" : ""}${p.lo.toFixed(1)}, ${p.hi >= 0 ? "+" : ""}${p.hi.toFixed(1)}] · n=${p.n} · ${p.better} / ${p.worse}` : "–")

lines.push("", "## Against cold (facts remembered, per fresh session, 95% bootstrap CI, better / worse)", "")
for (const arm of armsSeen.filter((a) => a.name !== "cold")) lines.push(`- ${arm.name}: ${fmt(paired(arm.name, "cold", (r) => score(r).facts))}`)

const ranked = armsSeen
  .filter((a) => !["cold", "cold+hint", "full"].includes(a.name))
  .map((a) => ({
    name: a.name,
    facts: armRows[a.name].facts.reduce((s, x) => s + x, 0) / Math.max(1, armRows[a.name].facts.length),
    tasks: armRows[a.name].tasks.reduce((s, x) => s + x, 0) / Math.max(1, armRows[a.name].tasks.length),
    ctx: median(armRows[a.name].ctx),
  }))
  .sort((x, y) => y.facts - x.facts || y.tasks - x.tasks || x.ctx - y.ctx)
const best = ranked[0]
if (best) {
  lines.push("", `## Pre-registered hypotheses for the best mechanism: ${best.name}`, "")
  const c1 = armsSeen
    .filter((a) => !["cold", "cold+hint", "full"].includes(a.name))
    .map((a) => paired(a.name, "cold", (r) => score(r).facts))
    .filter(Boolean) as NonNullable<ReturnType<typeof paired>>[]
  lines.push(`- C1 every handoff arm beats cold: ${c1.every((p) => p.lo > 0) ? "**pass**" : "**fail**"} (${c1.filter((p) => p.lo > 0).length} of ${c1.length} intervals exclude zero)`)
  lines.push(`- C2 ≥ 90% of facts remembered: ${best.facts >= 0.9 ? "**pass**" : "**fail**"} (${pct(best.facts * 100, 100)})`)
  lines.push(`- C3 rules applied no worse than the in-session default: ${pct(best.tasks * 100, 100)} here; compare with the planted default arm in bench/results/planted-test.md`)
  const full = armRows.full
  lines.push(`- C4 prompt ≤ 25% of full: ${full ? (best.ctx <= 0.25 * median(full.ctx) ? "**pass**" : "**fail**") : "–"} (${k(best.ctx)} vs ${full ? k(median(full.ctx)) : "–"})`)
  const hint = armRows["cold+hint"]
  const recallArms = armsSeen.filter((a) => a.recall)
  lines.push(
    `- C5 recall arms need fewer lookups than cold+hint: ${hint ? recallArms.map((a) => `${a.name} ${(armRows[a.name].lookups.reduce((s, x) => s + x, 0) / Math.max(1, armRows[a.name].lookups.length)).toFixed(1)}`).join(", ") : "–"} vs ${hint ? (hint.lookups.reduce((s, x) => s + x, 0) / Math.max(1, hint.lookups.length)).toFixed(1) : "–"}`,
  )
  lines.push(
    "",
    `Winner rule (facts, then rules, then smaller prompt): ${ranked
      .slice(0, 5)
      .map((r) => `${r.name} ${pct(r.facts * 100, 100)}/${pct(r.tasks * 100, 100)}/${k(r.ctx)}`)
      .join(" · ")}`,
  )
}

const errors = [...results.entries()].filter(([, r]) => r.errors.length)
if (errors.length > 0) {
  lines.push("", "## Errors", "")
  for (const [key, r] of errors) lines.push(`- ${key}: ${r.errors.join(" · ").slice(0, 200)}`)
}

const out = path.join(dir, `report.${split}.md`)
writeFileSync(out, `${lines.join("\n")}\n`)
console.log(lines.join("\n"))
