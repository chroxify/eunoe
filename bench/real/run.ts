/**
 * The benchmark, built to survive someone trying to take it apart.
 *
 * It answers one question: when a long coding session runs out of context,
 * which strategy leaves the agent knowing more? Everything else in the design
 * is there to stop the answer from being an artefact.
 *
 * ARMS
 *   native        Claude Code's own compaction, exactly as it shipped.
 *   native+guide  The same context, plus the identical transcript-search
 *                 instructions the eunoe arms get. Isolates "did it have the
 *                 information" from "did it know how to go and find it" — the
 *                 confound that would otherwise make the headline meaningless.
 *   tail          A sliding window: keep the first message, drop the oldest
 *                 whole turns until it fits. No reduction, no summary. It is
 *                 handed the *entire* budget, which in practice is several
 *                 times what eunoe uses, so the baseline gets every advantage.
 *   eunoe         The cut: every earlier turn as prompt + final reply, the
 *                 live turn whole.
 *   rolling       The hybrid: the last 3 finished turns whole, every older
 *                 turn as prompt + final reply, the live turn whole. Live, the
 *                 cut moves forward in steps (once 100k tokens of older detail
 *                 build up), so the request stays append-only between steps
 *                 and the cache keeps hitting. Measured right after a step:
 *                 the least recent detail it ever holds.
 *   trim          Every finished turn already reduced, all session long.
 *   full          No compaction at all. The ceiling, where the history fits.
 *
 * GUARDS
 *   - Questions are generated from the raw history *including tool output for
 *     every turn*, with a quota drawn from tool output specifically — the
 *     material eunoe drops. The exam is not written from the answer sheet.
 *   - An oracle holding the whole pre-cut history vets every question before
 *     any arm runs. Questions it can't answer, or whose reference answer it
 *     contradicts, are discarded and never scored.
 *   - Two judges from different model families score every answer. Agreement
 *     is reported; the mean is used. A benchmark with one judge measures the
 *     judge.
 *   - Judges see shuffled, anonymous labels, and every arm runs the same
 *     answering model, so there is no self-preference asymmetry.
 *   - Judges also label each answer correct / partial / unknown / wrong, so a
 *     confident fabrication can be counted separately from an honest "I don't
 *     know". They are not the same failure.
 *   - Arms that lose their prompt or hit a usage limit are retried, never
 *     recorded as a zero.
 *
 *   bun bench/real/run.ts points              choose the points, write points.json, run nothing
 *   bun bench/real/run.ts prepare [n] [par]   + generate and vet every point's questions, then stop
 *   bun bench/real/run.ts run [n] [par]       + arms and judges (resume-safe; prepared questions are reused)
 *
 * Every Claude call runs on one pinned account (CONFIG_DIR), so the whole
 * benchmark draws on a single subscription and never touches the live login.
 * When that subscription stays limited for CREDITS_AFTER_MS, calls fall back
 * to API credits (~/.config/eunoe-bench/api-key) for CREDITS_FOR_MS, then try
 * the subscription again.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ARMS as ALL_ARMS, armSpec } from "../arms"
import { API_KEY, BASE_SETTINGS, CONFIG_DIR, NO_TOOLS, READ_ONLY, claude, projectDir } from "../lib/claude"
import { extractJson } from "../lib/json"
import { blocks, clean, findPoints, parse, realPrompt, sessionRoots, textOf, type Entry } from "../lib/points"
import { proxyRequests as requestsOf, startProxies as spawnProxies } from "../lib/proxy"

export const OUT = path.join(import.meta.dir, "..", "out", "real")
export const ANSWER_MODEL = process.env.BENCH_ANSWER_MODEL ?? "claude-opus-5-5"
export const ORACLE_MODEL = "claude-opus-5-5"
export const JUDGES = ["claude-opus-5-5", "claude-sonnet-5-5"]
const PHASE = (["points", "prepare", "run"].includes(process.argv[2] ?? "") ? process.argv[2] : "run") as "points" | "prepare" | "run"
const NUMERIC = process.argv.slice(2).filter((a) => /^\d+$/.test(a))
const TOTAL = Number(NUMERIC[0] ?? 40)
const PARALLEL = Number(NUMERIC[1] ?? 3)
const SEED = 20261008
const QUESTIONS = 12
export const REPLICATE = Number(process.env.BENCH_REPLICATE ?? 1)
const SUFFIX = REPLICATE > 1 ? `.r${REPLICATE}` : ""

export type Arm = string
export const ARMS: Arm[] = process.env.BENCH_ARMS?.split(",") ?? ["native", "native+guide", "tail", "eunoe", "rolling", "trim", "full"]
for (const arm of ARMS) armSpec(arm)
// BENCH_TAG keeps a run's results apart from the original run; tagged runs also
// pin every arm to one canonical system prompt and tool list per point.
export const RUN_TAG = process.env.BENCH_TAG
const RESULTS = RUN_TAG ? path.join(OUT, "runs", RUN_TAG) : OUT
export const PROXIES = path.join(OUT, "proxies")
export const proxyFor = (arm: Arm) => armSpec(arm).proxy

mkdirSync(path.join(OUT, "transcripts"), { recursive: true })

/** Deterministic per-point shuffle, so the anonymous labels are reproducible. */
export function seededShuffle<T>(items: T[], index: number): T[] {
  let s = (SEED + index * 7919) >>> 0
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// ---------------------------------------------------------------- points

export interface BenchPoint {
  kind: "real" | "synthetic"
  sessionId: string
  cwd: string
  lines: string[]
  cutLine: number
  tokensAtCut: number
  turnsBefore: number
  native?: { durationMs: number; preTokens: number; postTokens?: number }
}

export function contextOf(entry: Entry) {
  const u = entry.message?.usage
  return u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0
}

function syntheticPoints(exclude: Set<string>): BenchPoint[] {
  const out: BenchPoint[] = []
  for (const root of sessionRoots()) {
    let projects: string[]
    try { projects = Array.from(new Bun.Glob("*").scanSync({ cwd: root, onlyFiles: false })) } catch { continue }
    for (const project of projects) {
      const dir = path.join(root, project)
      let names: string[]
      try { names = Array.from(new Bun.Glob("*.jsonl").scanSync({ cwd: dir })) } catch { continue }
      for (const name of names) {
        const sessionId = name.slice(0, -6)
        if (exclude.has(sessionId)) continue
        const file = path.join(dir, name)
        const stat = Bun.file(file).size
        if (stat < 2_000_000) continue
        const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
        const entries = parse(lines)
        const cwd = entries.find((e) => typeof e.cwd === "string")?.cwd
        if (!cwd || !existsSync(cwd)) continue
        let last = 0
        let turns = 0
        let cut = -1
        let after = 0
        for (let i = 0; i < entries.length; i += 1) {
          const e = entries[i]
          if (e.subtype === "compact_boundary") break
          if (e.type === "assistant" && !e.isSidechain && contextOf(e)) last = contextOf(e)
          if (!realPrompt(e)) continue
          if (cut === -1) {
            turns += 1
            if (turns > 20 && last >= 350_000) cut = i
          } else after += 1
        }
        if (cut === -1 || after < 2) continue
        let next = cut + 1
        while (next < entries.length && !realPrompt(entries[next])) next += 1
        out.push({ kind: "synthetic", sessionId, cwd, lines, cutLine: next, tokensAtCut: last, turnsBefore: turns })
      }
    }
  }
  return out
}

export function choosePoints(): BenchPoint[] {
  const perProject = new Map<string, number>()
  const take = (cwd: string, cap: number) => {
    const n = perProject.get(cwd) ?? 0
    if (n >= cap) return false
    perProject.set(cwd, n + 1)
    return true
  }
  // The same session can sit under several config roots (Kanna's old
  // per-account dirs mirror ~/.claude/projects), sometimes under a new id.
  const seen = new Set<string>()
  const fresh = (p: { sessionId: string; cwd: string; turnsBefore: number; cutLine: number; lines: string[] }) => {
    const signature = `${p.cwd}|${p.turnsBefore}|${p.cutLine}|${p.lines[0]?.length ?? 0}`
    if (seen.has(p.sessionId) || seen.has(signature)) return false
    seen.add(p.sessionId)
    seen.add(signature)
    return true
  }
  const real: BenchPoint[] = []
  for (const p of findPoints()) {
    if (!fresh({ ...p, cutLine: p.boundaryIndex }) || p.turnsBefore < 20 || !take(p.cwd, 3)) continue
    const meta = p.entries[p.boundaryIndex].compactMetadata
    real.push({
      kind: "real", sessionId: p.sessionId, cwd: p.cwd, lines: p.lines, cutLine: p.boundaryIndex,
      tokensAtCut: p.preTokens, turnsBefore: p.turnsBefore,
      native: { durationMs: meta?.durationMs ?? 0, preTokens: meta?.preTokens ?? 0, postTokens: meta?.postTokens },
    })
  }
  const synthetic = syntheticPoints(seen).filter((p) => fresh(p) && take(p.cwd, 3))
  // Half and half where the data allows it; when one stratum runs short the
  // other fills in, and the per-stratum counts are reported.
  const half = Math.ceil(TOTAL / 2)
  const syntheticTaken = synthetic.slice(0, half)
  return [...real.slice(0, TOTAL - syntheticTaken.length), ...syntheticTaken].slice(0, TOTAL)
}

// ---------------------------------------------------------------- questions

/**
 * The material questions are written from: the raw history, with tool output
 * for *every* turn, not only recent ones. If the generator only sees what
 * eunoe keeps, the questions measure nothing.
 */
export function sourceMaterial(point: BenchPoint): string {
  const entries = parse(point.lines.slice(0, point.cutLine))
  const out: string[] = []
  let turn = 0
  let ago = 0
  const turnsTotal = entries.filter(realPrompt).length
  for (const entry of entries) {
    if (entry.isSidechain) continue
    if (realPrompt(entry)) {
      turn += 1
      ago = turnsTotal - turn
      out.push(`\n### Turn ${turn} (${ago === 0 ? "IN PROGRESS when the context filled" : `${ago} before the cut`})\nUSER: ${clean(textOf(entry)).slice(0, 2500)}`)
      continue
    }
    if (!turn) continue
    if (entry.type === "assistant") {
      for (const b of blocks(entry.message)) {
        if (b.type === "text" && String(b.text).trim()) out.push(`AGENT: ${String(b.text).slice(0, 2000)}`)
        if (b.type === "tool_use") {
          const i = b.input ?? {}
          out.push(`TOOL CALL ${b.name}: ${String(i.command ?? i.file_path ?? i.pattern ?? i.url ?? JSON.stringify(i)).replace(/\s+/g, " ").slice(0, 400)}`)
        }
      }
    }
    if (entry.type === "user") {
      for (const b of blocks(entry.message)) {
        if (b.type !== "tool_result") continue
        const c = typeof b.content === "string" ? b.content : (b.content ?? []).map((x: any) => x.text ?? "").join("\n")
        if (c.trim()) out.push(`TOOL OUTPUT: ${c.replace(/\s+/g, " ").slice(0, 1500)}`)
      }
    }
  }
  const after = parse(point.lines.slice(point.cutLine)).filter(realPrompt).slice(0, 2).map((e) => clean(textOf(e)).slice(0, 1200))
  let text = out.join("\n")
  if (text.length > 420_000) text = "[earliest turns truncated]\n" + text.slice(-420_000)
  return `${text}\n\n=== WHAT THE USER ASKED NEXT, AFTER THE CUT (only for the continuation reference answers) ===\n${after.join("\n---\n")}`
}

const GENERATOR = `Below is the complete history of a real coding session, turn by turn, up to the moment its context window filled up. Each turn is labelled with how many turns before the cut it happened, and includes the user's message, what the agent said, every tool call, and the tool output.

Write a memory test for an agent that has to continue this session after its context was compacted. Exactly ${QUESTIONS} questions, each with a short, specific, checkable reference answer taken from this history. Never guessable from general knowledge.

Quotas, and they matter:
- 3 x "tool_evidence": the answer appears ONLY in TOOL OUTPUT or a TOOL CALL, never in what the agent said in prose. An exact value a command printed, a filename from a listing, a count, an error string, an ID. At least one from more than 15 turns before the cut.
- 2 x "mid_history": what was worked on 5-15 turns before the cut and how it ended. Name the topic, never the turn number.
- 2 x "instruction": a standing instruction, preference or constraint the user gave earlier that still binds at the cut. Make it hard: prefer one that was given 5+ turns before the cut, that a reasonable agent might violate by default, or that was changed partway through — if it was revised, the answer is the revision. Ask it the way a real follow-up would test it ("Should you commit this yourself or wait for me?").
- 1 x "decision": what was decided and why, including an option that was considered and rejected.
- 2 x "continuation": what the agent was mid-way through when the context filled and what comes next; and what was promised or left open but not finished.
- 2 x "recent": the answer appears ONLY in TOOL OUTPUT or a TOOL CALL from 1 to 3 turns before the cut (never the live turn, never in prose). The detail a user would expect the agent to still have in front of it: what the last test run printed, a value from a file it just read.

Write questions whose answer is one fact, not an essay. Do not ask anything answerable from the final two turns alone unless it is a continuation or recent question. For each give "turnsAgo": how many turns before the cut the answer comes from (0 = the live turn).

Return only JSON: {"questions":[{"id":1,"type":"tool_evidence","turnsAgo":17,"question":"...","answer":"..."}, ...]}

=== SESSION HISTORY ===
`

const ORACLE = (questions: any[], material: string) => `Below are questions about a coding session, each with the reference answer it expects, followed by the complete session history.

For each question decide one thing: does this history clearly support that reference answer?

"ok" means the evidence is there and the reference answer is right. "bad" means anything else — not in the history, ambiguous, the history contradicts the reference, or it cannot be answered as asked. Be strict: a question that only nearly works is "bad". This filter exists so that no strategy is penalised for a broken question.

Return only JSON: {"verdicts":[{"id":1,"verdict":"ok|bad","why":"<10 words"}, ...]}

=== QUESTIONS ===
${questions.map((q) => `${q.id}. [${q.type}] ${q.question}\n   REFERENCE: ${q.answer}`).join("\n")}

=== SESSION HISTORY ===
${material}`

const ANSWER = (questions: any[]) => `Stop the current work for a moment: this is a memory check about this session. Do not continue the task and do not change anything.

Answer each question about what happened earlier in this session. Use what is in your context. If it isn't there and you know where this session's transcript is, search it (read-only). Do not inspect the project's files or git history to reconstruct answers — they must come from this conversation. Say you don't know rather than guessing.

${questions.map((q) => `${q.id}. ${q.question}`).join("\n")}

Reply with only JSON: {"answers":[{"id":1,"answer":"...","source":"context|transcript|unknown"}, ...]}`

const JUDGE = (questions: any[], sets: Record<string, any[]>) => {
  const labels = Object.keys(sets)
  return `Grade answers from ${labels.length} agents to a memory test about a coding session. For each question you get the reference answer and each agent's answer.

For every answer give:
  "score": 2 correct and specific (matches the reference in substance) · 1 partly correct or vague · 0 wrong, missing or declined
  "label": "correct" · "partial" · "unknown" (it said it did not know) · "wrong" (it asserted something the reference contradicts)

Judge only agreement with the reference. Do not reward length, confidence or style. "unknown" and "wrong" both score 0, but they are different failures and must be labelled apart.

${questions.map((q) => [
    `Q${q.id} (${q.type}): ${q.question}`,
    `REFERENCE: ${q.answer}`,
    ...labels.map((l) => `${l}: ${String(sets[l].find((a: any) => a.id === q.id)?.answer ?? "(no answer)").slice(0, 1000)}`),
  ].join("\n")).join("\n\n")}

Reply with only JSON: {"grades":{${labels.map((l) => `"${l}":[{"id":1,"score":0,"label":"unknown"}, …]`).join(",")}}}`
}

// ---------------------------------------------------------------- session copies

export function writeCopy(point: BenchPoint, lines: string[], id: string, edit?: (e: Entry) => Entry) {
  const file = path.join(projectDir(point.cwd), `${id}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, lines.map((line) => {
    try {
      let e = JSON.parse(line)
      if (e.sessionId) e.sessionId = id
      if (edit) e = edit(e)
      return JSON.stringify(e)
    } catch { return null }
  }).filter(Boolean).join("\n") + "\n")
  return file
}

/** The CLI refuses to send what it estimates past the window, so size the copy by what the proxy will actually send. */
export function shrinkUsage(e: Entry) {
  if (e.message?.usage) e.message.usage = { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: e.message.usage.output_tokens ?? 0 }
  return e
}

export function repointSummary(transcriptCopy: string) {
  return (e: Entry) => {
    if (!e.isCompactSummary) return e
    const swap = (s: string) => s.replace(/(read the full transcript at:\s*)\S+/g, `$1${transcriptCopy}`)
    const c = e.message.content
    e.message.content = typeof c === "string" ? swap(c) : c.map((b: any) => (b.type === "text" ? { ...b, text: swap(b.text) } : b))
    return e
  }
}

/**
 * Tool calls the arm made after the memory check, split by what they looked
 * at: the transcript it was told about, or anything else (the project's own
 * files, which the prompt forbids and which would answer `recent` questions
 * without memory). The split is reported as a validity guard.
 */
export function lookupsAfterQuestion(file: string, projectCwd = "") {
  if (!existsSync(file)) return { calls: 0, transcript: 0, project: 0, byTool: {} as Record<string, number> }
  const entries = parse(readFileSync(file, "utf8").split("\n").filter(Boolean))
  const q = entries.findLastIndex((e) => e.type === "user" && textOf(e).includes("this is a memory check"))
  const byTool: Record<string, number> = {}
  let calls = 0
  let transcript = 0
  let project = 0
  for (const e of entries.slice(q + 1)) {
    if (e.type !== "assistant") continue
    for (const b of blocks(e.message)) {
      if (b.type !== "tool_use") continue
      calls += 1
      const cmd = String(b.input?.command ?? "")
      const key = b.name === "Bash" ? (cmd.match(/\bqmd \w+/)?.[0] ?? cmd.match(/\b(rg|grep|jq|sed|awk|cat|head|tail|ls)\b/)?.[0] ?? "bash") : b.name
      byTool[key] = (byTool[key] ?? 0) + 1
      const target = JSON.stringify(b.input ?? {})
      if (/transcripts?\//.test(target) || /\bqmd\b/.test(target)) transcript += 1
      else if (!projectCwd || target.includes(projectCwd) || !/\/Users\//.test(target)) project += 1
    }
  }
  return { calls, transcript, project, byTool }
}

const normalized = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim()

function lookupHits(file: string, questions: any[]): number[] {
  if (!existsSync(file)) return []
  const entries = parse(readFileSync(file, "utf8").split("\n").filter(Boolean))
  const q = entries.findLastIndex((e) => e.type === "user" && textOf(e).includes("this is a memory check"))
  const read = normalized(entries.slice(q + 1).filter((e) => e.type === "user")
    .flatMap((e) => blocks(e.message).filter((b) => b.type === "tool_result"))
    .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""))).join("\n"))
  return questions
    .filter((x) => (x.type === "tool_evidence" || x.type === "recent") && normalized(String(x.answer)).length >= 3 && read.includes(normalized(String(x.answer))))
    .map((x) => x.id)
}

export function skillsBeforeCut(point: BenchPoint): string[] {
  const found = new Set<string>()
  for (const line of point.lines.slice(0, point.cutLine)) {
    for (const match of line.matchAll(/Base directory for this skill: ([^\s"\\]+)/g)) found.add(match[1].split("/").at(-1)!)
  }
  return [...found].sort()
}

export const proxyRequests = (arm: Arm, sessionId: string) => requestsOf(PROXIES, proxyFor(arm), sessionId)

// ---------------------------------------------------------------- one point

interface Prepared {
  questions: any[]
  oracle: Record<string, { ok: boolean; why: string }>
  kept: any[]
}

/** Questions and their vetting, written once per point so a review or a restart never regenerates them. */
async function preparePoint(point: BenchPoint, tag: string, log: (m: string) => void): Promise<Prepared | null> {
  const file = path.join(OUT, `${tag}.questions.json`)
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"))
  const material = sourceMaterial(point)
  log(`questions (${point.turnsBefore} turns, ${Math.round(point.tokensAtCut / 1000)}k at cut)`)
  const gen = await claude(["--model", ANSWER_MODEL, ...NO_TOOLS], { cwd: OUT, stdin: GENERATOR + material })
  let questions: any[]
  try { questions = extractJson(gen.result).questions } catch { log(`question generation failed: ${String(gen.result).slice(0, 160)}`); return null }

  // Vet before anything expensive runs: a bad question costs every arm.
  const vet = await claude(["--model", ORACLE_MODEL, ...NO_TOOLS], { cwd: OUT, stdin: ORACLE(questions, material) })
  const oracle: Record<string, { ok: boolean; why: string }> = {}
  try {
    for (const v of extractJson(vet.result).verdicts) oracle[String(v.id)] = { ok: v.verdict === "ok", why: v.why ?? "" }
  } catch { log("oracle failed; keeping every question") }
  const kept = questions.filter((q) => oracle[String(q.id)]?.ok !== false)
  log(`questions: ${kept.length}/${questions.length} vetted`)
  const prepared = { questions, oracle, kept }
  writeFileSync(file, JSON.stringify(prepared, null, 2))
  return prepared
}

async function runPoint(point: BenchPoint, index: number) {
  const tag = `p${String(index).padStart(2, "0")}`
  mkdirSync(RESULTS, { recursive: true })
  const resultFile = path.join(RESULTS, `${tag}${SUFFIX}.json`)
  if (existsSync(resultFile)) return JSON.parse(readFileSync(resultFile, "utf8"))
  const log = (m: string) => console.log(`[${tag} ${point.kind} ${path.basename(point.cwd)}] ${m}`)
  const pre = point.lines.slice(0, point.cutLine)
  const transcriptCopy = path.join(OUT, "transcripts", `${tag}.jsonl`)
  writeFileSync(transcriptCopy, pre.join("\n") + "\n")
  const created: string[] = []

  const prepared = await preparePoint(point, tag, log)
  if (!prepared) return null
  const { questions, oracle, kept } = prepared
  if (kept.length < 4) { log("too few usable questions, skipping point"); return null }
  if (PHASE === "prepare") return null

  // native context: the real compaction, or a genuine /compact on a copy
  let nativeLines: string[]
  let native = point.native
  if (point.kind === "real") {
    const all = parse(point.lines)
    const firstAfter = all.findIndex((e, i) => i > point.cutLine && e.type === "assistant" && !e.isSidechain)
    nativeLines = point.lines.slice(0, firstAfter === -1 ? point.lines.length : firstAfter)
  } else {
    log("native: running /compact")
    let file = ""
    const out = await claude(() => {
      if (file) rmSync(file, { force: true })
      const id = crypto.randomUUID()
      file = writeCopy(point, pre, id)
      created.push(file)
      return ["--resume", id, "--model", ANSWER_MODEL, "--settings", JSON.stringify(BASE_SETTINGS)]
    }, { cwd: point.cwd, stdin: "/compact" })
    const after = readFileSync(file, "utf8").split("\n").filter(Boolean)
    const boundary = parse(after).find((e) => e.subtype === "compact_boundary")
    if (!boundary) { log(`/compact produced no summary: ${String(out.result).slice(0, 160)}`); return null }
    native = { durationMs: boundary.compactMetadata?.durationMs ?? out.wallMs, preTokens: boundary.compactMetadata?.preTokens ?? 0, postTokens: boundary.compactMetadata?.postTokens }
    nativeLines = after
  }
  // Tier 2 continues from the same native context, so keep it.
  writeFileSync(path.join(OUT, "transcripts", `${tag}${SUFFIX}.native.jsonl`), nativeLines.join("\n") + "\n")
  // Both native arms get their summary's transcript pointer aimed at the copy
  // that stops at the cut, so nothing from after the cut is reachable.
  const nativeEdit = repointSummary(transcriptCopy)

  const arms = ARMS.filter((a) => a !== "full" || (point.kind === "synthetic" && point.tokensAtCut < 700_000))
  const answers: Record<string, any> = {}
  // Natives resume a compacted session, which Claude Code answers with a shorter
  // system prompt; in a tagged run they wait until an arm resuming the uncut
  // session has captured the canonical one, then get it too.
  const canon = path.join(OUT, "canon", `${tag}.json`)
  const pinned = Boolean(RUN_TAG) && arms.some((a) => a !== "native" && a !== "native+guide")
  await Promise.all(arms.map(async (arm) => {
    const isNative = arm === "native" || arm === "native+guide"
    const deadline = Date.now() + 30 * 60_000
    if (pinned && isNative) while (!existsSync(canon) && Date.now() < deadline) await Bun.sleep(1_000)
    const lines = isNative ? nativeLines : pre
    const env = {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${armSpec(arm).port}`,
      ANTHROPIC_CUSTOM_HEADERS: [`x-eunoe-transcript: ${transcriptCopy}`, ...(pinned ? [`x-eunoe-canonical: ${canon}`] : [])].join("\n"),
    }
    let id = ""
    let file = ""
    const out = await claude(() => {
      if (file) rmSync(file, { force: true })
      id = crypto.randomUUID()
      file = writeCopy(point, lines, id, isNative ? nativeEdit : shrinkUsage)
      created.push(file)
      return ["--resume", id, "--model", ANSWER_MODEL, "--permission-mode", "default", "--settings", JSON.stringify({ ...BASE_SETTINGS, autoCompactEnabled: false, env }), "--allowedTools", READ_ONLY]
    }, { cwd: point.cwd, stdin: ANSWER(kept), env })
    let parsed: any[] = []
    try { parsed = extractJson(out.result).answers } catch {}
    const requests = proxyRequests(arm, id)
    answers[arm] = {
      answers: parsed,
      raw: String(out.result ?? "").slice(0, 3000),
      error: parsed.length ? undefined : String(out.result ?? "").slice(0, 300),
      wallMs: out.wallMs,
      agentTurns: out.num_turns,
      lookups: lookupsAfterQuestion(file, point.cwd),
      foundByLookup: lookupHits(file, kept),
      context: requests.find((r) => r.context)?.context ?? null,
      keptTurns: requests.find((r) => r.keptTurns)?.keptTurns ?? null,
      contextAtQuestion: requests.find((r) => r.input)?.input ?? null,
      requests: requests.length,
      tokensProcessed: requests.reduce((s, r) => s + (r.input ?? 0), 0),
      cacheRead: requests.reduce((s, r) => s + (r.cacheRead ?? 0), 0),
      cacheWrite: requests.reduce((s, r) => s + (r.cacheWrite ?? 0), 0),
      outputTokens: out.usage?.output_tokens ?? null,
      note: requests.find((r) => r.action)?.action ?? null,
    }
    log(`${arm}: ${parsed.length} answers, ${answers[arm].lookups.calls} lookups, ${Math.round(out.wallMs / 1000)}s, ctx ${Math.round((answers[arm].contextAtQuestion ?? 0) / 1000)}k`)
  }))
  for (const f of created) rmSync(f, { force: true })

  // two judges, shuffled anonymous labels, every arm that answered
  const answered = arms.filter((a) => answers[a].answers.length)
  const order = seededShuffle(answered, index + (REPLICATE - 1) * 1000)
  const labels = order.map((_, i) => String.fromCharCode(65 + i))
  const sets = Object.fromEntries(order.map((arm, i) => [labels[i], answers[arm].answers]))
  const grades: Record<string, Record<string, Array<{ score: number; label: string }>>> = {}
  await Promise.all(JUDGES.map(async (model, j) => {
    await Bun.sleep(j * 1200)
    const out = await claude(["--model", model, ...NO_TOOLS], { cwd: OUT, stdin: JUDGE(kept, sets) })
    try {
      const raw = extractJson(out.result).grades
      grades[model] = Object.fromEntries(order.map((arm, i) => [arm, kept.map((q) => {
        const g = (raw[labels[i]] ?? []).find((x: any) => x.id === q.id) ?? {}
        return { score: typeof g.score === "number" ? g.score : 0, label: String(g.label ?? "unknown") }
      })]))
    } catch { log(`judge ${model} failed`) }
  }))
  if (!Object.keys(grades).length) { log("no judge succeeded"); return null }

  const result = { tag, replicate: REPLICATE, kind: point.kind, cwd: point.cwd, session: point.sessionId, cutLine: point.cutLine, turnsBefore: point.turnsBefore, tokensAtCut: point.tokensAtCut, skillsBeforeCut: skillsBeforeCut(point), native, questions: kept, allQuestions: questions, oracle, labels: Object.fromEntries(order.map((arm, i) => [arm, labels[i]])), answers, grades, judges: JUDGES, answerModel: ANSWER_MODEL }
  writeFileSync(resultFile, JSON.stringify(result, null, 2))
  const totals = order.map((a) => {
    const per = JUDGES.filter((m) => grades[m]?.[a]).map((m) => grades[m][a].reduce((s, g) => s + g.score, 0))
    return `${a} ${(per.reduce((x, y) => x + y, 0) / per.length).toFixed(1)}`
  })
  log(`scores /${kept.length * 2}: ${totals.join("  ")}`)
  return result
}

// ---------------------------------------------------------------- main

export const startProxies = () => spawnProxies(ALL_ARMS.filter((a) => ARMS.includes(a.name)), PROXIES, { window: 1_000_000 })

if (import.meta.main) {
  const points = choosePoints()
  console.log(`${PHASE}${REPLICATE > 1 ? ` (replicate ${REPLICATE})` : ""}: ${points.length} points (${points.filter((p) => p.kind === "real").length} real, ${points.filter((p) => p.kind === "synthetic").length} synthetic) · account ${path.basename(CONFIG_DIR)} · credits ${API_KEY ? "on standby" : "none"}`)
  const pointsFile = path.join(OUT, "points.json")
  const listed = points.map((p, i) => ({ tag: `p${String(i).padStart(2, "0")}`, kind: p.kind, cwd: p.cwd, session: p.sessionId, cutLine: p.cutLine, turns: p.turnsBefore, tokensAtCut: p.tokensAtCut }))
  // The point list is fixed the first time it is written; later runs must match it.
  if (existsSync(pointsFile)) {
    const fixed = JSON.parse(readFileSync(pointsFile, "utf8"))
    const mismatch = listed.findIndex((p, i) => !fixed[i] || fixed[i].session !== p.session || fixed[i].cutLine !== p.cutLine)
    if (mismatch !== -1 && mismatch < fixed.length) { console.error(`points.json disagrees at ${listed[mismatch].tag}; delete it to re-select`); process.exit(1) }
  } else {
    writeFileSync(pointsFile, JSON.stringify(listed, null, 2))
  }
  for (const p of listed) console.log(`  ${p.tag} ${p.kind.padEnd(9)} ${String(p.turns).padStart(4)} turns ${String(Math.round(p.tokensAtCut / 1000)).padStart(5)}k  ${p.cwd}`)
  if (PHASE === "points") process.exit(0)
  const proxies = PHASE === "run" ? startProxies() : []
  await Bun.sleep(1500)
  try {
    let next = 0
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      while (next < points.length) {
        const i = next++
        await runPoint(points[i], i).catch((e) => console.error(`[p${i}]`, e))
      }
    }))
  } finally {
    proxies.forEach((p) => p.kill())
  }
  console.log("done")
}
