/**
 * Score a real-session run against SPEC.md, offline. Reads bench/out/real/p*.json
 * (recall tier) and c*.json (continuation tier, when present) and writes
 * results.md + results.json next to them.
 *
 * Everything here is arithmetic over what the arms already produced; no model
 * is called. The hypothesis table reports every pre-registered test, passes
 * and fails alike, with the bootstrap CI that decides it.
 *
 *   bun bench/real/validate.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const OUT = path.join(import.meta.dir, "..", "out", "real")
const ARMS = ["native", "native+guide", "tail", "eunoe", "rolling", "trim", "full"] as const
type Arm = (typeof ARMS)[number]
const TYPES = ["tool_evidence", "mid_history", "instruction", "decision", "continuation", "recent"]
const BUCKETS: Array<[string, (n: number) => boolean]> = [
  ["live", (n) => n === 0],
  ["1-3", (n) => n >= 1 && n <= 3],
  ["4-10", (n) => n >= 4 && n <= 10],
  ["11-25", (n) => n >= 11 && n <= 25],
  ["26+", (n) => n >= 26],
]
const NON_INFERIORITY = -10
const BOOTSTRAP = 20_000

interface Question { id: number; type: string; turnsAgo?: number; question: string; answer: string }
interface Grade { score: number; label: string }
interface ArmResult {
  answers: Array<{ id: number; answer: string; source?: string }>
  error?: string
  wallMs: number
  lookups: { calls: number; transcript?: number; project?: number; byTool: Record<string, number> }
  foundByLookup: number[]
  context: { session: string | null; system: string; tools: string; skills: string[]; given?: { system: string; tools: string } } | null
  keptTurns: number | null
  contextAtQuestion: number | null
  tokensProcessed: number
  cacheRead: number
  cacheWrite: number
}
interface Result {
  tag: string
  replicate?: number
  reps?: Result[]
  kind: "real" | "synthetic"
  cwd: string
  turnsBefore: number
  tokensAtCut: number
  skillsBeforeCut: string[]
  native?: { durationMs: number; preTokens: number; postTokens?: number }
  questions: Question[]
  answers: Record<string, ArmResult>
  grades: Record<string, Record<string, Grade[]>>
  judges: string[]
}

// ---------------------------------------------------------------- stats

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN)
const sd = (xs: number[]) => {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}
let seed = 20261008
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
function ci(diffs: number[]): [number, number] {
  if (diffs.length < 3) return [NaN, NaN]
  const means: number[] = []
  for (let r = 0; r < BOOTSTRAP; r += 1) {
    let total = 0
    for (let i = 0; i < diffs.length; i += 1) total += diffs[Math.floor(rand() * diffs.length)]
    means.push(total / diffs.length)
  }
  means.sort((a, b) => a - b)
  return [means[Math.floor(BOOTSTRAP * 0.025)], means[Math.floor(BOOTSTRAP * 0.975)]]
}
const powerN = (effect: number, spread: number) => (effect ? Math.max(3, Math.ceil(7.849 * spread ** 2 / effect ** 2)) : Infinity)
const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "–")
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "–")

// ---------------------------------------------------------------- scoring

const replicates = (r: Result) => [r, ...(r.reps ?? [])]

/** Judge-mean score (0–2) per kept question for one arm in one replicate, or null when the arm has no grades. */
function scoresOf(r: Result, arm: string): number[] | null {
  const judged = r.judges.filter((m) => r.grades[m]?.[arm])
  if (!judged.length || !r.answers[arm]?.answers?.length) return null
  return r.questions.map((_, i) => mean(judged.map((m) => r.grades[m][arm][i]?.score ?? 0)))
}
/** The same, averaged over every replicate of the point that graded the arm. */
function scores(r: Result, arm: string): number[] | null {
  const per = replicates(r).map((x) => scoresOf(x, arm)).filter((s): s is number[] => s !== null)
  if (!per.length) return null
  return r.questions.map((_, i) => mean(per.map((s) => s[i])))
}
function labelsOf(r: Result, arm: string): string[] | null {
  const judged = r.judges.filter((m) => r.grades[m]?.[arm])
  if (!judged.length || !r.answers[arm]?.answers?.length) return null
  // Fabrication is counted when either judge saw it.
  return r.questions.map((_, i) => (judged.some((m) => r.grades[m][arm][i]?.label === "wrong") ? "wrong" : judged.every((m) => r.grades[m][arm][i]?.label === "unknown") ? "unknown" : judged[0] ? r.grades[judged[0]][arm][i]?.label ?? "unknown" : "unknown"))
}
/** Labels pooled over replicates, for rates. Index-aligned uses take one replicate at a time. */
function pooledLabels(r: Result, arm: string): string[] | null {
  const per = replicates(r).map((x) => labelsOf(x, arm)).filter((l): l is string[] => l !== null)
  return per.length ? per.flat() : null
}
/** Per-point % of max over a subset of questions. */
function pointPct(r: Result, arm: string, keep: (q: Question, i: number) => boolean = () => true): number | null {
  const s = scores(r, arm)
  if (!s) return null
  let got = 0
  let max = 0
  r.questions.forEach((q, i) => { if (keep(q, i)) { got += s[i]; max += 2 } })
  return max ? (100 * got) / max : null
}
function paired(results: Result[], a: string, b: string, keep?: (q: Question, i: number) => boolean) {
  const diffs: number[] = []
  for (const r of results) {
    const x = pointPct(r, a, keep)
    const y = pointPct(r, b, keep)
    if (x !== null && y !== null) diffs.push(x - y)
  }
  const m = mean(diffs)
  const s = sd(diffs)
  const [lo, hi] = ci(diffs)
  return { n: diffs.length, mean: m, sd: s, lo, hi, powerN: powerN(Math.abs(m), s) }
}
const line = (p: ReturnType<typeof paired>) => `n=${p.n} mean ${pct(p.mean)} [${pct(p.lo)}, ${pct(p.hi)}] sd ${fmt(p.sd)} · 80% power needs ${p.powerN === Infinity ? "–" : p.powerN}`

/** Which questions an arm could only answer by searching the transcript. */
function needsLookup(r: Result, arm: string, q: Question): boolean | null {
  if (!(q.type === "tool_evidence" || q.type === "recent") || (q.turnsAgo ?? 0) === 0) return false
  const ago = q.turnsAgo ?? 0
  switch (arm) {
    case "eunoe": case "trim": return true
    case "rolling": return ago > 3
    case "tail": { const kept = r.answers.tail?.keptTurns; return kept ? ago >= kept : null }
    case "full": return false
    default: return null
  }
}

// ---------------------------------------------------------------- load

const files = (await Array.fromAsync(new Bun.Glob("p[0-9][0-9]*.json").scan({ cwd: OUT, absolute: true }))).filter((f) => /p\d\d(\.r\d+)?\.json$/.test(f)).sort()
const loaded: Result[] = files.map((f) => JSON.parse(readFileSync(f, "utf8")))
const all: Result[] = loaded.filter((r) => !r.replicate || r.replicate === 1)
const droppedReps: string[] = []
for (const rep of loaded.filter((r) => (r.replicate ?? 1) > 1)) {
  const primary = all.find((r) => r.tag === rep.tag)
  const sameQuestions = primary && primary.questions.length === rep.questions.length && primary.questions.every((q, i) => q.id === rep.questions[i].id)
  if (!sameQuestions) { droppedReps.push(`${rep.tag} r${rep.replicate}`); continue }
  ;(primary.reps ??= []).push(rep)
}
const md: string[] = []
const say = (s = "") => md.push(s)
const table = (head: string[], rows: string[][]) => {
  say(`| ${head.join(" | ")} |`)
  say(`|${head.map(() => "---").join("|")}|`)
  for (const row of rows) say(`| ${row.join(" | ")} |`)
  say()
}

say(`# Real-session suite: results`)
say()
const repCount = all.map((r) => replicates(r).length)
say(`${all.length} scored points (${all.filter((r) => r.kind === "real").length} real, ${all.filter((r) => r.kind === "synthetic").length} synthetic) · ${all.reduce((n, r) => n + r.questions.length, 0)} vetted questions · judges ${all[0]?.judges.join(", ") ?? "–"} · replicates per point ${repCount.length ? `${Math.min(...repCount)}–${Math.max(...repCount)}` : "–"}${droppedReps.length ? ` · replicates dropped for a question mismatch: ${droppedReps.join(", ")}` : ""}`)
say()
if (repCount.some((n) => n > 1)) {
  say(`Where a point has more than one replicate, every score is the per-question mean over its replicates (SPEC §2, amendment); label rates pool the replicates.`)
  say()
}

// ---------------------------------------------------------------- guards

say(`## Validity guards`)
say()
const fingerprintProblems: string[] = []
for (const r of all) {
  const given = replicates(r).flatMap((x) => ARMS.map((a) => x.answers[a]?.context?.given)).filter(Boolean) as Array<{ system: string; tools: string }>
  const systems = new Set(given.map((g) => g.system))
  const tools = new Set(given.map((g) => g.tools))
  if (systems.size > 1 || tools.size > 1) fingerprintProblems.push(`${r.tag}: ${systems.size} system prompts, ${tools.size} tool lists across arms`)
}
say(`- **Same system prompt and tools in every arm:** ${fingerprintProblems.length ? `**${fingerprintProblems.length} point(s) differ** — ${fingerprintProblems.join("; ")}` : "every point identical across arms (hash of what Claude Code sent, before eunoe's rewrite)"}`)

const gated = all.filter((r) => scores(r, "full") && scores(r, "native"))
const nonDiscriminating = gated.filter((r) => (pointPct(r, "full") ?? 0) <= (pointPct(r, "native") ?? 0))
say(`- **\`full\` as the difficulty gate:** ${gated.length} point(s) have a no-compaction ceiling; ${nonDiscriminating.length} of them (${nonDiscriminating.map((r) => r.tag).join(", ") || "none"}) did not separate full from native and are excluded from the headline. Real points (history past 700k) cannot be gated and stay in.`)
const headline = all.filter((r) => !nonDiscriminating.includes(r))

let agree = 0
let within = 0
let pairs = 0
for (const r of all.flatMap(replicates)) {
  if (r.judges.length < 2) continue
  for (const arm of ARMS) {
    const [a, b] = r.judges.map((m) => r.grades[m]?.[arm])
    if (!a || !b) continue
    r.questions.forEach((_, i) => {
      pairs += 1
      if (a[i].score === b[i].score) agree += 1
      if (Math.abs(a[i].score - b[i].score) <= 1) within += 1
    })
  }
}
say(`- **Judge agreement** over ${pairs} double-graded answers: ${pairs ? Math.round((100 * agree) / pairs) : 0}% exact, ${pairs ? Math.round((100 * within) / pairs) : 0}% within one point${pairs && agree / pairs < 0.7 ? " — **below the 70% threshold; a third judge is required before publication**" : ""}.`)

let dead = 0
let aced = 0
let separating = 0
for (const r of all) {
  const armScores = ARMS.map((a) => scores(r, a)).filter(Boolean) as number[][]
  r.questions.forEach((_, i) => {
    const vals = armScores.map((s) => s[i])
    if (!vals.length) return
    if (vals.every((v) => v === 0)) dead += 1
    else if (vals.every((v) => v === 2)) aced += 1
    else separating += 1
  })
}
const projectReads = ARMS.map((a) => { const rs = all.filter((r) => r.answers[a]?.lookups); return rs.length ? `${a} ${rs.reduce((n, r) => n + (r.answers[a].lookups.project ?? 0), 0)}/${rs.reduce((n, r) => n + r.answers[a].lookups.calls, 0)}` : null }).filter(Boolean)
say(`- **Lookups that were not the transcript** (project files or elsewhere; the prompt forbids them, and a \`recent\` answer found that way is memory of nothing): ${projectReads.join(" · ") || "none"}`)
say(`- **Question shape:** ${separating} questions separated the arms, ${aced} were aced by every arm, ${dead} were failed by every arm (suspect even after the oracle).`)
const perfect = ARMS.map((a) => { const xs = all.map((r) => pointPct(r, a)).filter((x): x is number => x !== null); return xs.length ? `${a} ${Math.round((100 * xs.filter((x) => x === 100).length) / xs.length)}%` : null }).filter(Boolean)
say(`- **Ceiling (perfect points per arm):** ${perfect.join(" · ")}`)
const projects: Record<string, number> = {}
for (const r of all) projects[path.basename(r.cwd)] = (projects[path.basename(r.cwd)] ?? 0) + 1
say(`- **Points per project:** ${Object.entries(projects).map(([p, n]) => `${p} ${n}`).join(" · ")}`)
say()

// ---------------------------------------------------------------- per-arm table

say(`## Recall by arm (headline set, ${headline.length} points)`)
say()
const cell = (arm: string, keep?: (q: Question, i: number) => boolean) => {
  const xs = headline.map((r) => pointPct(r, arm, keep)).filter((x): x is number => x !== null)
  return xs.length ? `${Math.round(mean(xs))}%` : "–"
}
table(
  ["arm", "all", ...TYPES.map((t) => t.replace("_", " ")), "pts", "ctx (median)", "sec", "lookups", "wrong", "unknown"],
  ARMS.filter((a) => headline.some((r) => scores(r, a))).map((arm) => {
    const rs = headline.filter((r) => scores(r, arm))
    const lab = rs.flatMap((r) => pooledLabels(r, arm) ?? [])
    return [
      arm,
      `**${cell(arm)}**`,
      ...TYPES.map((t) => cell(arm, (q) => q.type === t)),
      String(rs.length),
      `${Math.round(median(rs.map((r) => r.answers[arm].contextAtQuestion ?? 0)) / 1000)}k`,
      fmt(median(rs.map((r) => r.answers[arm].wallMs / 1000)), 0),
      fmt(mean(rs.map((r) => r.answers[arm].lookups.calls))),
      `${Math.round((100 * lab.filter((l) => l === "wrong").length) / Math.max(1, lab.length))}%`,
      `${Math.round((100 * lab.filter((l) => l === "unknown").length) / Math.max(1, lab.length))}%`,
    ]
  }),
)

say(`### By distance from the cut (turns ago)`)
say()
table(["arm", ...BUCKETS.map(([name]) => name)], ARMS.filter((a) => headline.some((r) => scores(r, a))).map((arm) => [arm, ...BUCKETS.map(([, inBucket]) => cell(arm, (q) => inBucket(q.turnsAgo ?? 0)))]))

say(`### By stratum`)
say()
for (const kind of ["real", "synthetic"] as const) {
  const rs = headline.filter((r) => r.kind === kind)
  if (!rs.length) continue
  say(`**${kind}** (${rs.length} points): ${ARMS.map((a) => { const xs = rs.map((r) => pointPct(r, a)).filter((x): x is number => x !== null); return xs.length ? `${a} ${Math.round(mean(xs))}%` : null }).filter(Boolean).join(" · ")}`)
  say()
}

// ---------------------------------------------------------------- transcript use

say(`## Transcript use (H9)`)
say()
const lookupRows: string[][] = []
const lookupStats: Record<string, { needed: number; found: number; scoreFound: number[]; scoreMissed: number[]; wrongUnsearched: number; unsearched: number; wasted: number }> = {}
for (const arm of ARMS) {
  const st = { needed: 0, found: 0, scoreFound: [] as number[], scoreMissed: [] as number[], wrongUnsearched: 0, unsearched: 0, wasted: 0 }
  for (const r of headline.flatMap(replicates)) {
    const s = scoresOf(r, arm)
    const lab = labelsOf(r, arm)
    if (!s || !lab) continue
    const found = new Set(r.answers[arm].foundByLookup ?? [])
    r.questions.forEach((q, i) => {
      const need = needsLookup(r, arm, q)
      if (need === null) return
      if (need) {
        st.needed += 1
        if (found.has(q.id)) { st.found += 1; st.scoreFound.push(s[i]) } else {
          st.scoreMissed.push(s[i])
          st.unsearched += 1
          if (lab[i] === "wrong") st.wrongUnsearched += 1
        }
      } else if (found.has(q.id)) st.wasted += 1
    })
  }
  lookupStats[arm] = st
  if (st.needed || arm === "native" || arm === "native+guide") {
    lookupRows.push([arm, arm === "native" || arm === "native+guide" ? "not classified" : String(st.needed), st.needed ? `${Math.round((100 * st.found) / st.needed)}%` : "–", fmt(mean(st.scoreFound), 2), fmt(mean(st.scoreMissed), 2), st.unsearched ? `${Math.round((100 * st.wrongUnsearched) / st.unsearched)}%` : "–", String(st.wasted)])
  }
}
table(["arm", "needed a lookup", "found by lookup", "score when found (0–2)", "score when not", "guessed wrong when it didn't search", "lookups it didn't need"], lookupRows)

// ---------------------------------------------------------------- skills

say(`## Skills after the cut (H10)`)
say()
const withSkills = headline.filter((r) => r.skillsBeforeCut?.length)
const skillRate: Record<string, string> = {}
for (const arm of ARMS) {
  let have = 0
  let total = 0
  for (const r of withSkills.flatMap(replicates)) {
    const ctx = r.answers[arm]?.context
    if (!ctx) continue
    for (const skill of r.skillsBeforeCut) { total += 1; if (ctx.skills.includes(skill)) have += 1 }
  }
  if (total) skillRate[arm] = `${Math.round((100 * have) / total)}% (${have}/${total})`
}
say(`${withSkills.length} point(s) loaded a skill before the cut${withSkills.length < 10 ? " — **fewer than 10, so H10 is reported as untested**" : ""}. Retention per arm: ${Object.entries(skillRate).map(([a, v]) => `${a} ${v}`).join(" · ") || "no skill data"}.`)
say()

// ---------------------------------------------------------------- continuation (tier 2)

interface Continuation {
  tag: string
  kind: string
  arms: Record<string, { fidelity: number | null; violations: number | null; redundant: number | null; transcriptReadsBeforeActing: number; wallMs: number; toolCalls: number; tokens: number } | null>
}
const cFiles = (await Array.fromAsync(new Bun.Glob("c[0-9][0-9].json").scan({ cwd: OUT, absolute: true }))).sort()
const cont: Continuation[] = cFiles.map((f) => JSON.parse(readFileSync(f, "utf8")))
const contArms = ARMS.filter((a) => a !== "full")
const contMetric = (arm: string, key: "fidelity" | "violations" | "redundant") => cont.map((c) => c.arms[arm]?.[key]).filter((x): x is number => typeof x === "number")
const contPaired = (a: string, b: string, key: "fidelity" | "violations" | "redundant") => {
  const diffs = cont.flatMap((c) => { const x = c.arms[a]?.[key]; const y = c.arms[b]?.[key]; return typeof x === "number" && typeof y === "number" ? [x - y] : [] })
  const m = mean(diffs)
  const s = sd(diffs)
  const [lo, hi] = ci(diffs)
  return { n: diffs.length, mean: m, sd: s, lo, hi, powerN: powerN(Math.abs(m), s) }
}
if (cont.length) {
  say(`## Continuation (tier 2, ${cont.length} points)`)
  say()
  table(["arm", "task fidelity (0–2)", "instruction violations", "redundant work", "read the transcript before acting", "tool calls", "sec", "tokens"], contArms.filter((a) => cont.some((c) => c.arms[a])).map((arm) => {
    const rs = cont.filter((c) => c.arms[arm])
    return [arm, fmt(mean(contMetric(arm, "fidelity")), 2), fmt(mean(contMetric(arm, "violations")), 2), fmt(mean(contMetric(arm, "redundant")), 2), `${rs.filter((c) => c.arms[arm]!.transcriptReadsBeforeActing > 0).length}/${rs.length}`, fmt(mean(rs.map((c) => c.arms[arm]!.toolCalls)), 1), fmt(median(rs.map((c) => c.arms[arm]!.wallMs / 1000)), 0), `${Math.round(mean(rs.map((c) => c.arms[arm]!.tokens)) / 1000)}k`]
  }))
}

// ---------------------------------------------------------------- hypotheses

say(`## Pre-registered hypotheses`)
say()
const rows: string[][] = []
const verdict = (ok: boolean | null, note = "") => (ok === null ? `inconclusive${note}` : ok ? `**pass**${note}` : `**fail**${note}`)

const h1 = paired(headline, "eunoe", "native")
rows.push(["H1 eunoe recalls more than native", "eunoe − native > 0", line(h1), verdict(h1.n < 3 ? null : h1.lo > 0)])
const h2 = paired(headline, "eunoe", "tail")
rows.push(["H2 structure, not size: eunoe non-inferior to a bigger sliding window", `eunoe − tail ≥ ${NON_INFERIORITY}%`, line(h2), h2.n < 3 ? verdict(null) : h2.lo >= NON_INFERIORITY ? verdict(true) : h2.hi < NON_INFERIORITY ? verdict(false) : verdict(null, " (CI straddles the bound)")])
const h3 = paired(headline, "native+guide", "native")
rows.push(["H3 native's gap is not a search-skill artefact", "(native+guide) − native < +25%", line(h3), verdict(h3.n < 3 ? null : h3.hi < 25)])
const wrongRate = (r: Result, arm: string) => { const l = pooledLabels(r, arm); return l ? (100 * l.filter((x) => x === "wrong").length) / l.length : null }
const h4d = headline.flatMap((r) => { const a = wrongRate(r, "eunoe"); const b = wrongRate(r, "native"); return a !== null && b !== null ? [a - b] : [] })
const h4 = { n: h4d.length, mean: mean(h4d), sd: sd(h4d), ...(([lo, hi]) => ({ lo, hi }))(ci(h4d)), powerN: powerN(Math.abs(mean(h4d)), sd(h4d)) }
rows.push(["H4 eunoe fails honestly (wrong-answer rate)", "eunoe − native < 0", line(h4), verdict(h4.n < 3 ? null : h4.hi < 0)])
if (cont.length) {
  const h5 = contPaired("eunoe", "native", "fidelity")
  rows.push(["H5 eunoe continues the task better", "fidelity eunoe − native > 0", line(h5), verdict(h5.n < 3 ? null : h5.lo > 0)])
  const h6 = contPaired("eunoe", "native", "violations")
  rows.push(["H6 eunoe respects standing instructions after a cut", "violations eunoe − native < 0", line(h6), verdict(h6.n < 3 ? null : h6.hi < 0)])
} else {
  rows.push(["H5 eunoe continues the task better", "fidelity eunoe − native > 0", "tier 2 not run", "not run"])
  rows.push(["H6 eunoe respects standing instructions after a cut", "violations eunoe − native < 0", "tier 2 not run", "not run"])
}
const nativeCost = headline.filter((r) => r.native?.durationMs)
rows.push(["H7 compaction itself is cheaper", "fewer tokens and less wall time to compact, every point", `native's summary call: median ${fmt(median(nativeCost.map((r) => r.native!.durationMs / 1000)), 0)}s over ${Math.round(median(nativeCost.map((r) => r.native!.preTokens)) / 1000)}k tokens (${nativeCost.length} points); eunoe's cut: 0 tokens, 0 calls, a rewrite in the proxy`, verdict(nativeCost.length > 0)])
const h8a = paired(headline, "rolling", "trim", (q) => q.type === "recent")
const h8b = paired(headline, "rolling", "eunoe")
rows.push(["H8a recent detail is worth keeping: rolling beats trim on `recent` questions", "rolling − trim > 0 (recent only)", line(h8a), h8a.n < 3 ? verdict(null) : h8a.lo > 0 ? verdict(true) : h8a.hi < 0 ? verdict(false) : verdict(null, " (CI straddles zero)")])
rows.push(["H8b rolling non-inferior to eunoe overall", `rolling − eunoe ≥ ${NON_INFERIORITY}%`, line(h8b), h8b.n < 3 ? verdict(null) : h8b.lo >= NON_INFERIORITY ? verdict(true) : h8b.hi < NON_INFERIORITY ? verdict(false) : verdict(null, " (CI straddles the bound)")])
const e9 = lookupStats.eunoe
const h9d = headline.flatMap((r) => {
  const f: number[] = []
  const m: number[] = []
  for (const x of replicates(r)) {
    const s = scoresOf(x, "eunoe")
    if (!s) continue
    const found = new Set(x.answers.eunoe.foundByLookup ?? [])
    x.questions.forEach((q, i) => { if (needsLookup(x, "eunoe", q)) (found.has(q.id) ? f : m).push(s[i]) })
  }
  return f.length && m.length ? [mean(f) - mean(m)] : []
})
const h9 = { n: h9d.length, mean: mean(h9d), sd: sd(h9d), ...(([lo, hi]) => ({ lo, hi }))(ci(h9d)), powerN: powerN(Math.abs(mean(h9d)), sd(h9d)) }
rows.push(["H9 the agent actually uses the transcript", "eunoe finds ≥ 50% of cut answers by searching, and scores higher on those", `found ${e9?.needed ? Math.round((100 * e9.found) / e9.needed) : 0}% of ${e9?.needed ?? 0} needed · score found − not found (0–2): ${line(h9)}`, verdict(!e9?.needed ? null : e9.found / e9.needed >= 0.5 && (h9.n >= 3 ? h9.lo > 0 : false))])
const h10ok = withSkills.length >= 10 ? ["eunoe", "rolling", "trim"].every((a) => skillRate[a]?.startsWith("100%")) : null
rows.push(["H10 skills and instructions survive the cut", "eunoe, rolling, trim keep 100% of skills loaded before the cut", `${withSkills.length} points with skills · ${Object.entries(skillRate).map(([a, v]) => `${a} ${v}`).join(", ") || "no data"}`, h10ok === null ? "untested (fewer than 10 points with skills)" : verdict(h10ok)])
table(["hypothesis", "passes if", "observed", "verdict"], rows)

// ---------------------------------------------------------------- every pair, for the mode decision

say(`## Every arm against every other (headline set, all questions)`)
say()
const armsPresent = ARMS.filter((a) => headline.filter((r) => scores(r, a)).length >= 3)
table(["", ...armsPresent], armsPresent.map((a) => [a, ...armsPresent.map((b) => (a === b ? "·" : (() => { const p = paired(headline, a, b); return `${pct(p.mean, 0)} [${pct(p.lo, 0)}, ${pct(p.hi, 0)}]` })()))]))

say(`## Tokens per point per arm (headline set)`)
say()
table(["arm", "context at the question (median)", "tokens processed per answer (median)", "cache read", "cache written"], armsPresent.map((arm) => {
  const rs = headline.filter((r) => r.answers[arm]?.answers?.length)
  return [arm, `${Math.round(median(rs.map((r) => r.answers[arm].contextAtQuestion ?? 0)) / 1000)}k`, `${Math.round(median(rs.map((r) => r.answers[arm].tokensProcessed)) / 1000)}k`, `${Math.round(median(rs.map((r) => r.answers[arm].cacheRead)) / 1000)}k`, `${Math.round(median(rs.map((r) => r.answers[arm].cacheWrite)) / 1000)}k`]
}))

say(`## Per point`)
say()
table(["point", "kind", "project", "turns", "at cut", ...armsPresent], all.map((r) => [r.tag + (nonDiscriminating.includes(r) ? " (gated out)" : ""), r.kind, path.basename(r.cwd), String(r.turnsBefore), `${Math.round(r.tokensAtCut / 1000)}k`, ...armsPresent.map((a) => { const x = pointPct(r, a); return x === null ? "–" : `${Math.round(x)}%` })]))

writeFileSync(path.join(OUT, "results.md"), md.join("\n") + "\n")
writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ points: all.length, replicates: Object.fromEntries(all.map((r) => [r.tag, replicates(r).length])), headline: headline.map((r) => r.tag), gatedOut: nonDiscriminating.map((r) => r.tag), hypotheses: rows, lookups: lookupStats, skills: skillRate, judgeAgreement: pairs ? { exact: agree / pairs, within1: within / pairs, pairs } : null }, null, 2))
console.log(md.join("\n"))
