import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { outlineOf, SESSION_MIN_TERMS, SESSION_SOURCE_CANDIDATES, SESSION_SOURCE_MIN_TURNS } from "../../src/cli/sessions/source"
import { blocks, type Message } from "../../src/context/content"
import { type RecallChunk, rank, terms } from "../../src/context/recall"
import { sessionMessages } from "../../src/transcript/messages"
import { sessionRoots } from "../lib/points"
import { HANDOFF_OUT } from "./paths"

const REAL_PAIRS_OUT = path.join(HANDOFF_OUT, "real-pairs.md")

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

const COMMON_SHARE = 0.5

const CONTINUE_SHARE = 0.5

const CONTINUE_FILES = 2

interface Session {
  id: string
  project: string
  start: number
  first: string
  outline: string
  prompts: number
  edits: Set<string>
}
interface Case {
  id: string
  project: string
  prompt: string
  kind: "continue" | "new"
  truth: string | null
  candidates: Session[]
}

function startOf(file: string): number {
  for (const line of readFileSync(file, "utf8").split("\n", 40)) {
    const m = line.match(/"timestamp":"([^"]+)"/)
    if (m) return Date.parse(m[1])
  }
  return 0
}

function load(file: string, project: string): Session | null {
  let messages: Message[]
  try {
    messages = sessionMessages(file)
  } catch {
    return null
  }
  const outline = outlineOf(messages)
  if (outline.length === 0) return null
  const edits = new Set<string>()
  for (const m of messages)
    for (const b of blocks(m))
      if (b.type === "tool_use" && EDIT_TOOLS.has(String(b.name))) {
        const p = (b.input as any)?.file_path ?? (b.input as any)?.notebook_path
        if (typeof p === "string") edits.add(p)
      }
  return { id: path.basename(file, ".jsonl"), project, start: startOf(file), first: outline[0], outline: outline.map((l, i) => `${i + 1}. ${l}`).join("\n"), prompts: outline.length, edits }
}

const projects = new Map<string, Map<string, Session>>()
for (const root of sessionRoots())
  for (const project of readdirSync(root)) {
    let names: string[]
    try {
      names = readdirSync(path.join(root, project)).filter((f) => f.endsWith(".jsonl"))
    } catch {
      continue
    }
    const group = projects.get(project) ?? new Map<string, Session>()
    for (const name of names) {
      if (group.has(name.slice(0, -6))) continue
      const s = load(path.join(root, project, name), project)
      if (s) group.set(s.id, s)
    }
    projects.set(project, group)
  }

const cases: Case[] = []
for (const [project, group] of projects) {
  const sessions = [...group.values()].sort((a, b) => a.start - b.start)
  const counts = new Map<string, number>()
  for (const s of sessions) for (const f of s.edits) counts.set(f, (counts.get(f) ?? 0) + 1)
  const common = (f: string) => sessions.length >= 4 && (counts.get(f) ?? 0) / sessions.length > COMMON_SHARE
  for (const [i, b] of sessions.entries()) {
    const own = [...b.edits].filter((f) => !common(f))
    if (own.length < 2) continue
    const candidates = sessions
      .slice(0, i)
      .filter((a) => a.prompts >= SESSION_SOURCE_MIN_TURNS)
      .reverse()
      .slice(0, SESSION_SOURCE_CANDIDATES)
    if (candidates.length === 0) continue
    const overlap = candidates.map((a) => ({ a, shared: own.filter((f) => a.edits.has(f)).length })).sort((x, y) => y.shared - x.shared)
    const best = overlap[0]
    if (best.shared >= CONTINUE_FILES && best.shared / own.length >= CONTINUE_SHARE && (overlap[1]?.shared ?? 0) < best.shared) cases.push({ id: b.id, project, prompt: b.first, kind: "continue", truth: best.a.id, candidates })
    else if (best.shared === 0) cases.push({ id: b.id, project, prompt: b.first, kind: "new", truth: null, candidates })
  }
}

interface Scored {
  c: Case
  ranked: { id: string; score: number }[]
}
const scored: Scored[] = cases.map((c) => {
  const chunks: RecallChunk[] = c.candidates.map((s, i) => ({ turn: i, call: s.id, lines: [s.outline], terms: terms(s.outline) }))
  const ranked = rank(terms(c.prompt), chunks, SESSION_MIN_TERMS).map((r: any) => ({ id: c.candidates[r.index].id, score: r.score as number }))
  return { c, ranked }
})

interface Gate {
  minScore: number
  margin: number
}
const decide = (s: Scored, g: Gate) => {
  const [top, second] = s.ranked
  if (!top || top.score < g.minScore) return null
  if (second && top.score < second.score * g.margin) return null
  return top.id
}
function measure(set: Scored[], g: Gate) {
  const pos = set.filter((s) => s.c.kind === "continue")
  const neg = set.filter((s) => s.c.kind === "new")
  const picks = pos.map((s) => decide(s, g))
  return {
    right: pos.length > 0 ? picks.filter((p, i) => p === pos[i].c.truth).length / pos.length : 0,
    wrong: pos.length > 0 ? picks.filter((p, i) => p && p !== pos[i].c.truth).length / pos.length : 0,
    missed: pos.length > 0 ? picks.filter((p) => !p).length / pos.length : 0,
    falseInject: neg.length > 0 ? neg.filter((s) => decide(s, g)).length / neg.length : 0,
    pos: pos.length,
    neg: neg.length,
  }
}
const half = (id: string) => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 2
const tune = scored.filter((s) => half(s.c.id) === 0)
const check = scored.filter((s) => half(s.c.id) === 1)

const gates: Gate[] = []
for (const minScore of [0, 2, 4, 6, 8, 10, 12, 15, 20]) for (const margin of [1, 1.2, 1.5, 2]) gates.push({ minScore, margin })
const utility = (m: ReturnType<typeof measure>) => m.right - 2 * m.wrong - 2 * m.falseInject
const bestGate = gates.map((g) => ({ g, u: utility(measure(tune, g)) })).sort((a, b) => b.u - a.u)[0].g

const pct = (x: number) => `${Math.round(100 * x)}%`
const row = (name: string, set: Scored[], g: Gate) => {
  const m = measure(set, g)
  return `| ${name} | ${m.pos} / ${m.neg} | ${pct(m.right)} | ${pct(m.wrong)} | ${pct(m.missed)} | ${pct(m.falseInject)} |`
}
const lines = [
  "# Handoff selection on real history (no model)",
  "",
  `${projects.size} projects, ${cases.length} cases: ${cases.filter((c) => c.kind === "continue").length} continuations (same files as one earlier session), ${cases.filter((c) => c.kind === "new").length} new-work sessions (no shared files). Real first messages. Gate tuned on half the cases, reported on the other half.`,
  "",
  `Chosen gate: top bm25 score >= ${bestGate.minScore} and >= ${bestGate.margin}x the runner-up.`,
  "",
  "| gate | cases (continue / new) | right source | wrong source | abstained on a continuation | injected into new work |",
  "|---|---|---|---|---|---|",
  row("shipped (any 2-term match), tune", tune, { minScore: 0, margin: 1 }),
  row("shipped (any 2-term match), check", check, { minScore: 0, margin: 1 }),
  row("gated, tune", tune, bestGate),
  row("**gated, check**", check, bestGate),
]
writeFileSync(REAL_PAIRS_OUT, `${lines.join("\n")}\n`)
writeFileSync(
  path.join(HANDOFF_OUT, "real-pairs.json"),
  JSON.stringify(
    scored.map((s) => ({ id: s.c.id, project: s.c.project, kind: s.c.kind, truth: s.c.truth, prompt: s.c.prompt.slice(0, 200), ranked: s.ranked.slice(0, 3) })),
    null,
    1,
  ),
)
console.log(lines.join("\n"))
