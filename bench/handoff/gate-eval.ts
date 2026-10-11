import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SESSION_MIN_TERMS } from "../../src/cli/sessions/constants"
import { rank, terms } from "../../src/context/recall"
import type { RecallChunk } from "../../src/context/recall/types"
import { claude } from "../lib/claude"
import { NO_TOOLS } from "../lib/constants"
import { jev } from "../lib/jev"
import { extractJson } from "../lib/json"
import { GATE_CACHE, HANDOFF_OUT, JUDGE_Q, JUNK } from "./constants"
import { half, type Label, type RealCase, type RealSession, realCases } from "./real-cases"

const JUDGES = (process.argv.find((a) => a.startsWith("--judges="))?.slice(9) ?? "jev,haiku").split(",").filter(Boolean)
const labels: Record<string, Label> = JSON.parse(readFileSync(path.join(HANDOFF_OUT, "labels.json"), "utf8"))
const cases = realCases().filter((c) => labels[c.id])
const cache: Record<string, any> = existsSync(GATE_CACHE) ? JSON.parse(readFileSync(GATE_CACHE, "utf8")) : {}
const save = () => writeFileSync(GATE_CACHE, JSON.stringify(cache))

export const isJunk = (prompt: string) => JUNK.test(prompt) || new Set(terms(prompt)).size < 3

const recentOutline = (s: RealSession, count = 10) =>
  s.prompts
    .slice(-count)
    .map((prompt, i) => `${s.prompts.length - Math.min(count, s.prompts.length) + i + 1}. ${prompt}`)
    .join("count")
const bm25 = (prompt: string, cands: RealSession[], text: (s: RealSession) => string) => {
  const chunks: RecallChunk[] = cands.map((s, i) => ({ turn: i, call: s.id, lines: [text(s)], terms: terms(text(s)) }))
  return rank(terms(prompt), chunks, SESSION_MIN_TERMS).map((r: any) => ({ id: cands[r.index].id, score: r.score as number }))
}

const shortlist = (c: RealCase) => {
  const ranked = bm25(c.prompt, c.candidates, (s) => s.outline)
    .slice(0, 3)
    .map((r) => c.candidates.find((s) => s.id === r.id)!)
  for (const s of c.candidates) if (ranked.length < 3 && !ranked.includes(s)) ranked.push(s)
  return ranked
}
const opening = (c: RealCase, k: number) =>
  c.session.prompts
    .slice(0, k)
    .filter((p) => !isJunk(p))
    .map((p) => p.slice(0, 700))
    .join("\n---\n")
const shortlistFor = (c: RealCase, k: number) => {
  if (k === 1) return shortlist(c)
  const ranked = bm25(opening(c, k), c.candidates, (s) => s.outline)
    .slice(0, 3)
    .map((r) => c.candidates.find((s) => s.id === r.id)!)
  for (const s of c.candidates) if (ranked.length < 3 && !ranked.includes(s)) ranked.push(s)
  return ranked
}
const judgeState = (c: RealCase, list: RealSession[], k = 1) =>
  `A developer opens a new coding session. ${k === 1 ? "Its first message" : `Its first ${k} messages`}:\n${k === 1 ? c.prompt.slice(0, 1500) : opening(c, k)}\n\nEarlier sessions in the same project:\n${list.map((s, i) => `--- S${i + 1}${s.title ? ` · ${s.title}` : ""}\nlast messages:\n${recentOutline(s).slice(0, 1500)}`).join("\n\n")}`

async function judgeJev(c: RealCase) {
  const key = `jev:${c.id}`
  if (!(key in cache)) {
    const list = shortlist(c)
    const criteria: Record<string, string | null> = { none: "it starts different work, or it is unclear" }
    list.forEach((_s, i) => {
      criteria[`S${i + 1}`] = `it continues S${i + 1}`
    })
    try {
      const a: any = await jev("jev-latest", judgeState(c, list), { which: { type: "choice", instructions: JUDGE_Q, criteria } })
      const p = a.which.probabilities
      cache[key] = { ids: list.map((s) => s.id), p }
    } catch (e) {
      cache[key] = { error: String(e).slice(0, 200) }
    }
    save()
  }
  return cache[key]
}
async function judgeHaiku(c: RealCase, k = 1) {
  const key = k === 1 ? `haiku:${c.id}` : `haiku${k}:${c.id}`
  if (!(key in cache)) {
    if (k > 1 && !opening(c, k).trim()) {
      cache[key] = { ids: [], answer: "none", confidence: 0 }
      save()
      return cache[key]
    }
    const list = shortlistFor(c, k)
    const out = await claude(["--model", "claude-haiku-4-5-20251001", ...NO_TOOLS], {
      cwd: HANDOFF_OUT,
      account: process.env.BENCH_CSWAP_ACCOUNT,
      stdin: `${judgeState(c, list, k)}\n\n${JUDGE_Q}\nReturn only JSON: {"answer":"S1|S2|S3|none","confidence":0-100}`,
    })
    try {
      const j = extractJson(String(out.result ?? ""))
      cache[key] = { ids: list.map((s) => s.id), answer: j.answer, confidence: Number(j.confidence) }
    } catch {
      cache[key] = { error: String(out.result).slice(0, 200) }
    }
    save()
  }
  return cache[key]
}

let n = 0
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (;;) {
      const c = cases[n++]
      if (!c) return
      if (JUDGES.includes("jev")) await judgeJev(c)
      if (JUDGES.includes("haiku")) for (const k of [1, 2, 3]) if (c.session.prompts.length >= k) await judgeHaiku(c, k)
    }
  }),
)

type Rule = (c: RealCase) => string | null
const outcome = (c: RealCase, pick: string | null) => {
  const l = labels[c.id]
  if (!pick) return l.source ? "missed" : "abstain-ok"
  if (pick === l.source) return "right"
  if (l.partial.includes(pick)) return "partial"
  return l.source ? "wrong" : "false"
}
function measure(set: RealCase[], rule: Rule) {
  const counts = { right: 0, partial: 0, wrong: 0, missed: 0, false: 0, "abstain-ok": 0 } as Record<"right" | "partial" | "wrong" | "missed" | "false" | "abstain-ok", number>
  for (const c of set) counts[outcome(c, rule(c)) as keyof typeof counts] += 1
  const pos = set.filter((c) => labels[c.id].source).length
  const neg = set.length - pos
  const injected = counts.right + counts.partial + counts.wrong + counts.false
  return { ...counts, pos, neg, injected, utility: counts.right - 2 * (counts.wrong + counts.false) - counts.partial }
}

const rules: Record<string, Rule[] | Rule> = {}
rules["shipped (any 2-term match)"] = (c) => bm25(c.prompt, c.candidates, (s) => s.outline)[0]?.id ?? null
rules["bm25 + gate"] = [0, 5, 10, 15, 20, 25].flatMap((min) =>
  [1, 1.3, 1.6, 2].map((margin) => {
    const r: Rule = (c) => {
      if (isJunk(c.prompt)) return null
      const [a, b] = bm25(c.prompt, c.candidates, (s) => s.outline)
      return a && a.score >= min && (!b || a.score >= b.score * margin) ? a.id : null
    }
    ;(r as any).label = `score ≥ ${min}, margin ≥ ${margin}x`
    return r
  }),
)
rules["bm25 recent + gate"] = [0, 5, 10, 15, 20].flatMap((min) =>
  [1, 1.3, 1.6, 2].map((margin) => {
    const r: Rule = (c) => {
      if (isJunk(c.prompt)) return null
      const [a, b] = bm25(c.prompt, c.candidates, (s) => recentOutline(s))
      return a && a.score >= min && (!b || a.score >= b.score * margin) ? a.id : null
    }
    ;(r as any).label = `score ≥ ${min}, margin ≥ ${margin}x`
    return r
  }),
)
if (JUDGES.includes("jev"))
  rules["jev judge over bm25 top 3"] = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((t) => {
    const r: Rule = (c) => {
      if (isJunk(c.prompt)) return null
      const j = cache[`jev:${c.id}`]
      if (!j?.p) return null
      const best = Object.entries(j.p as Record<string, number>).sort((a, b) => b[1] - a[1])[0]
      return best && best[0] !== "none" && best[1] >= t ? j.ids[Number(best[0].slice(1)) - 1] : null
    }
    ;(r as any).label = `p ≥ ${t}`
    return r
  })
if (JUDGES.includes("haiku"))
  rules["haiku judge over bm25 top 3"] = [0, 50, 70, 80, 90].map((t) => {
    const r: Rule = (c) => {
      if (isJunk(c.prompt)) return null
      const j = cache[`haiku:${c.id}`]
      if (!j?.answer || j.answer === "none" || !(j.confidence >= t)) return null
      return j.ids[Number(String(j.answer).slice(1)) - 1] ?? null
    }
    ;(r as any).label = `confidence ≥ ${t}`
    return r
  })

const deferredPick = (c: RealCase, t: number, upTo: number) => {
  for (let k = 1; k <= Math.min(upTo, c.session.prompts.length); k += 1) {
    const j = cache[k === 1 ? `haiku:${c.id}` : `haiku${k}:${c.id}`]
    if (k === 1 && isJunk(c.prompt)) continue
    if (j?.answer && j.answer !== "none" && j.confidence >= t) return j.ids[Number(String(j.answer).slice(1)) - 1] ?? null
  }
  return null
}
if (JUDGES.includes("haiku"))
  for (const upTo of [2, 3])
    rules[`haiku judge, deferred to message ${upTo}`] = [50, 70, 80, 90].map((t) => {
      const r: Rule = (c) => deferredPick(c, t, upTo)
      ;(r as any).label = `confidence ≥ ${t}`
      return r
    })

const tune = cases.filter((c) => half(c.id) === 0)
const check = cases.filter((c) => half(c.id) === 1)
const pct = (x: number, d: number) => (d ? `${Math.round((100 * x) / d)}%` : "–")
const lines = [
  "# Handoff gate on labelled real history",
  "",
  `${cases.length} real sessions across ${new Set(cases.map((c) => c.project)).size} projects. Labels (Sonnet, reading every message of both sessions): ${cases.filter((c) => labels[c.id].source).length} continue one earlier session, ${cases.filter((c) => !labels[c.id].source).length} don't. Rules see only the first message. Parameters tuned on half (${tune.length}), reported on the other half (${check.length}).`,
  "",
  "| rule | chosen on tune | continuations: right | partial | wrong | missed | new work: falsely injected | utility (check) |",
  "|---|---|---|---|---|---|---|---|",
]
for (const [name, variants] of Object.entries(rules)) {
  const list = Array.isArray(variants) ? variants : [variants]
  const chosen = list.map((r) => ({ r, u: measure(tune, r).utility })).sort((a, b) => b.u - a.u)[0].r
  const m = measure(check, chosen)
  lines.push(`| ${name} | ${(chosen as any).label ?? "–"} | ${pct(m.right, m.pos)} | ${pct(m.partial, m.injected)} | ${pct(m.wrong, m.pos)} | ${pct(m.missed, m.pos)} | ${pct(m.false, m.neg)} | ${m.utility} |`)
}
const errors = Object.entries(cache).filter(([, v]: any) => v?.error).length
if (errors) lines.push("", `${errors} judge calls failed and count as abstain.`)
writeFileSync(path.join(HANDOFF_OUT, "gate-eval.md"), `${lines.join("\n")}\n`)
console.log(lines.join("\n"))
