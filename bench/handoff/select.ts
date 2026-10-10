import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { foldedView } from "../../src/context/fold"
import { rank, terms } from "../../src/context/recall"
import { sessionMessages } from "../../src/transcript/messages"
import { jev } from "../lib/jev"
import { loadMetas } from "../planted/run"
import { outline, sessionFile } from "./prepare"
import { HANDOFF_OUT, PROMPTS, SCENARIOS, SELECT_EMBED_CACHE, SELECT_SKIP } from "./constants"

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const split = arg("split") ?? "all"
const metas = loadMetas("all")
const picked = loadMetas(split)
const byRepo = new Map<string, typeof metas>()
for (const m of metas) byRepo.set(m.repo, [...(byRepo.get(m.repo) ?? []), m])

const textOf = { index: (m: (typeof metas)[number]) => outline(m), folded: (m: (typeof metas)[number]) => foldedView(sessionMessages(sessionFile(m))) }
const cache = new Map<string, string>()
const text = (kind: keyof typeof textOf, m: (typeof metas)[number]) => { const key = `${kind}:${m.id}`; if (!cache.has(key)) cache.set(key, textOf[kind](m)); return cache.get(key)! }

function bm25Pick(prompt: string, candidates: typeof metas, kind: keyof typeof textOf) {
  const chunks = candidates.map((m, i) => ({ turn: i, call: m.id, lines: [text(kind, m)], terms: terms(text(kind, m)) }))
  const ranked = rank(terms(prompt), chunks, 1)
  return ranked.length ? candidates[ranked[0].index].id : candidates[0].id
}

const embeds: Record<string, number[]> = existsSync(SELECT_EMBED_CACHE) ? JSON.parse(readFileSync(SELECT_EMBED_CACHE, "utf8")) : {}
let pipe: any
async function embed(key: string, value: string, prefix: string): Promise<number[]> {
  if (embeds[key]) return embeds[key]
  if (!pipe) {
    const mod = await import(path.join(import.meta.dir, "..", "tools", "models", "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs"))
    pipe = await mod.pipeline("feature-extraction", "Xenova/e5-small-v2", { dtype: "fp32" })
  }
  const out = await pipe([prefix + value.slice(0, 4000)], { pooling: "mean", normalize: true, truncation: true, max_length: 512 })
  embeds[key] = Array.from(out.data as Float32Array)
  writeFileSync(SELECT_EMBED_CACHE, JSON.stringify(embeds))
  return embeds[key]
}
const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0)

async function e5Pick(prompt: string, candidates: typeof metas) {
  const q = await embed(`q:${prompt}`, prompt, "query: ")
  const scored = await Promise.all(candidates.map(async (m) => [m.id, cos(q, await embed(`d:${m.id}`, text("index", m), "passage: "))] as const))
  return scored.sort((x, y) => y[1] - x[1])[0][0]
}

async function jevPick(prompt: string, candidates: typeof metas, kind: keyof typeof textOf = "index", chars = 2500) {
  const criteria = Object.fromEntries(candidates.map((m) => [m.id, `Session "${m.title}":\n${text(kind, m).slice(0, chars)}`]))
  const answers = await jev("jev-preview", `A developer opened a new session and wrote:\n${prompt}`, { which: { type: "choice", instructions: "Which earlier session is the developer coming back to? Match the work described, not the wording.", criteria } })
  return (answers.which as any).choice as string
}

function bm25Order(prompt: string, candidates: typeof metas, kind: keyof typeof textOf): string[] {
  const chunks = candidates.map((m, i) => ({ turn: i, call: m.id, lines: [text(kind, m)], terms: terms(text(kind, m)) }))
  const ranked = rank(terms(prompt), chunks, 1).map((r) => candidates[r.index].id)
  return [...ranked, ...candidates.map((m) => m.id).filter((id) => !ranked.includes(id))]
}

async function votePick(prompt: string, candidates: typeof metas) {
  const lists = [bm25Order(prompt, candidates, "index"), bm25Order(prompt, candidates, "folded"), [await jevPick(prompt, candidates, "folded", 12_000)]]
  const score = new Map<string, number>()
  for (const list of lists) list.forEach((id, r) => score.set(id, (score.get(id) ?? 0) + 1 / (1 + r)))
  return [...score.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

const rankers: Record<string, (prompt: string, candidates: typeof metas) => Promise<string> | string> = Object.fromEntries(Object.entries({
  recency: (_p: string, c: typeof metas) => c.reduce((a, b) => (a.index > b.index ? a : b)).id,
  bm25: (p: string, c: typeof metas) => bm25Pick(p, c, "index"),
  "bm25-full": (p: string, c: typeof metas) => bm25Pick(p, c, "folded"),
  e5: e5Pick,
  jev: jevPick,
  "jev-folded": (p: string, c: typeof metas) => jevPick(p, c, "folded", 12_000),
  vote: votePick,
}).filter(([name]) => !SELECT_SKIP.includes(name)))

const hits: Record<string, Record<string, number>> = {}
let total = 0
for (const meta of picked) {
  const promptFile = path.join(PROMPTS, `${meta.id}.json`)
  if (!existsSync(promptFile)) continue
  const candidates = byRepo.get(meta.repo)!
  if (candidates.length < 2) continue
  const prompts = JSON.parse(readFileSync(promptFile, "utf8"))
  for (const scenario of SCENARIOS) {
    total += 1
    for (const [name, pick] of Object.entries(rankers)) {
      let chosen = ""
      try { chosen = await pick(prompts[scenario], candidates) } catch (e) { console.error(`${name}: ${String(e).slice(0, 120)}`); continue }
      hits[name] ??= {}
      hits[name][scenario] = (hits[name][scenario] ?? 0) + (chosen === meta.id ? 1 : 0)
      hits[name].all = (hits[name].all ?? 0) + (chosen === meta.id ? 1 : 0)
    }
  }
}
const per = total / SCENARIOS.length
const lines = [`# Handoff selection (${split})`, "", `${total} resume prompts (${per} sessions × ${SCENARIOS.length} scenarios), each with the repository's other sessions as distractors. Hit = the chosen session is the one the prompt was written from.`, "", `| ranker | ${SCENARIOS.join(" | ")} | all |`, `|---|${SCENARIOS.map(() => "---").join("|")}|---|`]
for (const [name, h] of Object.entries(hits)) lines.push(`| ${name} | ${SCENARIOS.map((s) => `${Math.round((100 * (h[s] ?? 0)) / per)}%`).join(" | ")} | **${Math.round((100 * (h.all ?? 0)) / total)}%** |`)
writeFileSync(path.join(HANDOFF_OUT, `select.${split}.md`), lines.join("\n") + "\n")
console.log(lines.join("\n"))
