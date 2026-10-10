import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { blocks } from "../../src/context/content"
import { rank, terms } from "../../src/context/recall"
import { isPrompt, splitTurns } from "../../src/context/turns"
import { sessionMessages } from "../../src/transcript/messages"
import { claude } from "../lib/claude"
import { NO_TOOLS } from "../lib/constants"
import { jev } from "../lib/jev"
import { HANDOFF_OUT, REAL_RESUME, SELECT_REAL_OUT } from "./constants"

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const MAX = Number(arg("max") ?? 40)
const RANKERS = (arg("rankers") ?? "recency,bm25,jev,vote").split(",")
mkdirSync(SELECT_REAL_OUT, { recursive: true })

export interface Real { id: string; file: string; project: string; title: string; turns: number; outline: string; mtime: number }

const textOf = (m: any) => blocks(m).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()

function load(file: string, project: string): Real | null {
  let title = ""
  for (const line of readFileSync(file, "utf8").split("\n")) if (line.includes('"aiTitle"')) { try { title = JSON.parse(line).aiTitle ?? "" } catch {} break }
  const { turns } = splitTurns(sessionMessages(file))
  const prompts = turns.filter((t) => isPrompt(t[0])).map((t) => textOf(t[0])).filter(Boolean)
  if (prompts.length < 15) return null
  return { id: path.basename(file, ".jsonl"), file, project, title: title || prompts[0].slice(0, 80), turns: prompts.length, outline: prompts.map((p, i) => `${i + 1}. ${p.slice(0, 240)}`).join("\n"), mtime: Bun.file(file).lastModified }
}

function discover(): Real[][] {
  const root = path.join(homedir(), ".claude", "projects")
  const groups: Real[][] = []
  for (const project of readdirSync(root)) {
    const seen = new Set<string>()
    const sessions: Real[] = []
    for (const name of readdirSync(path.join(root, project)).filter((f) => f.endsWith(".jsonl"))) {
      const real = load(path.join(root, project, name), project)
      if (!real) continue
      const key = real.outline.slice(0, 200)
      if (seen.has(key)) continue
      seen.add(key)
      sessions.push(real)
    }
    if (sessions.length >= 2) groups.push(sessions.sort((a, b) => b.mtime - a.mtime))
  }
  return groups
}

async function resumePrompt(s: Real, scenario: string): Promise<string> {
  const file = path.join(SELECT_REAL_OUT, `${s.id}.${scenario}.txt`)
  if (existsSync(file)) return readFileSync(file, "utf8")
  const out = await claude(["--model", "claude-opus-5-5", ...NO_TOOLS], { cwd: SELECT_REAL_OUT, stdin: REAL_RESUME(s, scenario) })
  const text = String(out.result ?? "").trim()
  if (out.is_error || !text) throw new Error(`resume prompt failed for ${s.id}: ${text.slice(0, 120)}`)
  writeFileSync(file, text)
  return text
}

function bm25Pick(prompt: string, candidates: Real[]) {
  const chunks = candidates.map((s, i) => ({ turn: i, call: s.id, lines: [s.outline], terms: terms(s.outline) }))
  const ranked = rank(terms(prompt), chunks, 1)
  return ranked.length ? candidates[ranked[0].index].id : candidates[0].id
}
async function jevPick(prompt: string, candidates: Real[]) {
  const criteria = Object.fromEntries(candidates.map((s) => [s.id, `Session "${s.title}":\n${s.outline.slice(0, 2500)}`]))
  const answers = await jev("jev-preview", `A developer opened a new session and wrote:\n${prompt}`, { which: { type: "choice", instructions: "Which earlier session is the developer coming back to? Match the work described, not the wording.", criteria } })
  return (answers.which as any).choice as string
}
async function votePick(prompt: string, candidates: Real[]) {
  const a = bm25Pick(prompt, candidates)
  const b = await jevPick(prompt, candidates)
  if (a === b) return a
  const chunks = candidates.map((s, i) => ({ turn: i, call: s.id, lines: [s.outline], terms: terms(s.outline) }))
  const ranked = rank(terms(prompt), chunks, 1)
  const score = (id: string) => ranked.findIndex((r) => candidates[r.index].id === id)
  return score(b) >= 0 && score(b) <= 1 ? b : a
}
const rankers: Record<string, (p: string, c: Real[]) => Promise<string> | string> = {
  recency: (_p, c) => c[0].id,
  bm25: (p, c) => bm25Pick(p, c),
  jev: jevPick,
  vote: votePick,
}

const groups = discover()
const picked: Array<[Real, Real[]]> = []
for (const g of groups) for (const s of g) if (picked.length < MAX) picked.push([s, g])
console.error(`${groups.length} projects, ${groups.reduce((n, g) => n + g.length, 0)} sessions; evaluating ${picked.length} (max ${MAX}) × 2 scenarios`)
const hits: Record<string, Record<string, number>> = {}
let total = 0
const log: string[] = []
const ranks: number[] = []
for (const [s, candidates] of picked) {
  for (const scenario of ["bug", "continue"]) {
    let prompt: string
    try { prompt = await resumePrompt(s, scenario) } catch (e) { console.error(String(e).slice(0, 160)); continue }
    total += 1
    for (const name of RANKERS) {
      let chosen = ""
      try { chosen = await rankers[name](prompt, candidates) } catch (e) { console.error(`${name}: ${String(e).slice(0, 120)}`); continue }
      hits[name] ??= {}
      hits[name][scenario] = (hits[name][scenario] ?? 0) + (chosen === s.id ? 1 : 0)
      hits[name].all = (hits[name].all ?? 0) + (chosen === s.id ? 1 : 0)
      if (name === "bm25" && chosen !== s.id) {
        const chunks = candidates.map((c, i) => ({ turn: i, call: c.id, lines: [c.outline], terms: terms(c.outline) }))
        const where = rank(terms(prompt), chunks, 1).findIndex((r) => candidates[r.index].id === s.id)
        ranks.push(where < 0 ? 99 : where + 1)
      }
      if (name === "bm25" && chosen !== s.id) log.push(`miss bm25 ${s.project.slice(-25)} ${scenario}: "${prompt.slice(0, 90)}" → ${chosen.slice(0, 8)} (want ${s.id.slice(0, 8)} "${s.title.slice(0, 50)}") of ${candidates.length}`)
    }
  }
}
const per = total / 2
const lines = [`# Handoff selection on real history`, "", `${total} resume prompts (${per} sessions across ${groups.length} projects, 2 scenarios), candidates = the project's other sessions (2–${Math.max(...groups.map((g) => g.length))}). Hit = the chosen session is the one the prompt was written from.`, "", `| ranker | bug | continue | all |`, `|---|---|---|---|`]
for (const [name, h] of Object.entries(hits)) lines.push(`| ${name} | ${Math.round((100 * (h.bug ?? 0)) / per)}% | ${Math.round((100 * (h.continue ?? 0)) / per)}% | **${Math.round((100 * (h.all ?? 0)) / total)}%** |`)
lines.push("", `## bm25 misses (rank of the right session: ${ranks.map((r) => (r === 99 ? "unranked" : `#${r}`)).join(", ")}; within top 2: ${ranks.filter((r) => r <= 2).length} of ${ranks.length})`, "", ...log.map((l) => `- ${l}`))
writeFileSync(path.join(HANDOFF_OUT, "select-real.md"), lines.join("\n") + "\n")
console.log(lines.slice(0, 12).join("\n"))
