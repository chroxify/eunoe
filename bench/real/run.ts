import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { armSpec } from "../arms"
import { ARMS as ALL_ARMS } from "../constants"
import { claude, projectDir } from "../lib/claude"
import { API_KEY, BASE_SETTINGS, CONFIG_DIR, NO_TOOLS, READ_ONLY } from "../lib/constants"
import { extractJson } from "../lib/json"
import { blocks, clean, type Entry, findPoints, parse, realPrompt, sessionRoots, textOf } from "../lib/points"
import { proxyRequests as requestsOf, startProxies as spawnProxies } from "../lib/proxy"
import { ANSWER, ANSWER_MODEL, ARMS, GENERATOR, JUDGE, JUDGES, ORACLE, ORACLE_MODEL, OUT, PROXIES, REPLICATE, RESULTS, RUN_TAG, SEED, SUFFIX } from "./constants"

const PHASE = (["points", "prepare", "run"].includes(process.argv[2] ?? "") ? process.argv[2] : "run") as "points" | "prepare" | "run"
const NUMERIC = process.argv.slice(2).filter((a) => /^\d+$/.test(a))
const TOTAL = Number(NUMERIC[0] ?? 40)
const PARALLEL = Number(NUMERIC[1] ?? 3)

export type Arm = string
for (const arm of ARMS) armSpec(arm)
export const proxyFor = (arm: Arm) => armSpec(arm).proxy

mkdirSync(path.join(OUT, "transcripts"), { recursive: true })

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

function globOrEmpty(pattern: string, cwd: string, onlyFiles = true): string[] {
  try {
    return Array.from(new Bun.Glob(pattern).scanSync({ cwd, onlyFiles }))
  } catch {
    return []
  }
}

function syntheticCut(entries: Entry[]) {
  let last = 0
  let turns = 0
  let cut = -1
  let after = 0
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i]
    if (e.subtype === "compact_boundary") break
    if (e.type === "assistant" && !e.isSidechain && contextOf(e)) last = contextOf(e)
    if (!realPrompt(e)) continue
    if (cut !== -1) after += 1
    else {
      turns += 1
      if (turns > 20 && last >= 350_000) cut = i
    }
  }
  return { last, turns, cut, after }
}

function syntheticPoint(dir: string, name: string, exclude: Set<string>): BenchPoint | null {
  const sessionId = name.slice(0, -6)
  if (exclude.has(sessionId)) return null
  const file = path.join(dir, name)
  if (Bun.file(file).size < 2_000_000) return null
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
  const entries = parse(lines)
  const cwd = entries.find((e) => typeof e.cwd === "string")?.cwd
  if (!cwd || !existsSync(cwd)) return null
  const { last, turns, cut, after } = syntheticCut(entries)
  if (cut === -1 || after < 2) return null
  let next = cut + 1
  while (next < entries.length && !realPrompt(entries[next])) next += 1
  return { kind: "synthetic", sessionId, cwd, lines, cutLine: next, tokensAtCut: last, turnsBefore: turns }
}

function syntheticPoints(exclude: Set<string>): BenchPoint[] {
  const out: BenchPoint[] = []
  for (const root of sessionRoots()) {
    for (const project of globOrEmpty("*", root, false)) {
      const dir = path.join(root, project)
      for (const name of globOrEmpty("*.jsonl", dir)) {
        const point = syntheticPoint(dir, name, exclude)
        if (point) out.push(point)
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
      kind: "real",
      sessionId: p.sessionId,
      cwd: p.cwd,
      lines: p.lines,
      cutLine: p.boundaryIndex,
      tokensAtCut: p.preTokens,
      turnsBefore: p.turnsBefore,
      native: { durationMs: meta?.durationMs ?? 0, preTokens: meta?.preTokens ?? 0, postTokens: meta?.postTokens },
    })
  }
  const synthetic = syntheticPoints(seen).filter((p) => fresh(p) && take(p.cwd, 3))
  const half = Math.ceil(TOTAL / 2)
  const syntheticTaken = synthetic.slice(0, half)
  return [...real.slice(0, TOTAL - syntheticTaken.length), ...syntheticTaken].slice(0, TOTAL)
}

function assistantLines(entry: Entry): string[] {
  const out: string[] = []
  for (const b of blocks(entry.message)) {
    if (b.type === "text" && String(b.text).trim()) out.push(`AGENT: ${String(b.text).slice(0, 2000)}`)
    if (b.type !== "tool_use") continue
    const i = b.input ?? {}
    out.push(
      `TOOL CALL ${b.name}: ${String(i.command ?? i.file_path ?? i.pattern ?? i.url ?? JSON.stringify(i))
        .replace(/\s+/g, " ")
        .slice(0, 400)}`,
    )
  }
  return out
}

function toolOutputLines(entry: Entry): string[] {
  const out: string[] = []
  for (const b of blocks(entry.message)) {
    if (b.type !== "tool_result") continue
    const c = typeof b.content === "string" ? b.content : (b.content ?? []).map((x: any) => x.text ?? "").join("\n")
    if (c.trim()) out.push(`TOOL OUTPUT: ${c.replace(/\s+/g, " ").slice(0, 1500)}`)
  }
  return out
}

export function sourceMaterial(point: BenchPoint): string {
  const entries = parse(point.lines.slice(0, point.cutLine))
  const out: string[] = []
  let turn = 0
  const turnsTotal = entries.filter(realPrompt).length
  for (const entry of entries) {
    if (entry.isSidechain) continue
    if (realPrompt(entry)) {
      turn += 1
      const ago = turnsTotal - turn
      out.push(`\n### Turn ${turn} (${ago === 0 ? "IN PROGRESS when the context filled" : `${ago} before the cut`})\nUSER: ${clean(textOf(entry)).slice(0, 2500)}`)
      continue
    }
    if (!turn) continue
    if (entry.type === "assistant") out.push(...assistantLines(entry))
    if (entry.type === "user") out.push(...toolOutputLines(entry))
  }
  const after = parse(point.lines.slice(point.cutLine))
    .filter(realPrompt)
    .slice(0, 2)
    .map((e) => clean(textOf(e)).slice(0, 1200))
  let text = out.join("\n")
  if (text.length > 420_000) text = `[earliest turns truncated]\n${text.slice(-420_000)}`
  return `${text}\n\n=== WHAT THE USER ASKED NEXT, AFTER THE CUT (only for the continuation reference answers) ===\n${after.join("\n---\n")}`
}

export function writeCopy(point: BenchPoint, lines: string[], id: string, edit?: (e: Entry) => Entry) {
  const file = path.join(projectDir(point.cwd), `${id}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    `${lines
      .map((line) => {
        try {
          let e = JSON.parse(line)
          if (e.sessionId) e.sessionId = id
          if (edit) e = edit(e)
          return JSON.stringify(e)
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .join("\n")}\n`,
  )
  return file
}

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
  const read = normalized(
    entries
      .slice(q + 1)
      .filter((e) => e.type === "user")
      .flatMap((e) => blocks(e.message).filter((b) => b.type === "tool_result"))
      .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "")))
      .join("\n"),
  )
  return questions.filter((x) => (x.type === "tool_evidence" || x.type === "recent") && normalized(String(x.answer)).length >= 3 && read.includes(normalized(String(x.answer)))).map((x) => x.id)
}

export function skillsBeforeCut(point: BenchPoint): string[] {
  const found = new Set<string>()
  for (const line of point.lines.slice(0, point.cutLine)) {
    for (const match of line.matchAll(/Base directory for this skill: ([^\s"\\]+)/g)) found.add(match[1].split("/").at(-1)!)
  }
  return [...found].sort()
}

export const proxyRequests = (arm: Arm, sessionId: string) => requestsOf(PROXIES, proxyFor(arm), sessionId)

interface Prepared {
  questions: any[]
  oracle: Record<string, { ok: boolean; why: string }>
  kept: any[]
}

async function preparePoint(point: BenchPoint, tag: string, log: (m: string) => void): Promise<Prepared | null> {
  const file = path.join(OUT, `${tag}.questions.json`)
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"))
  const material = sourceMaterial(point)
  log(`questions (${point.turnsBefore} turns, ${Math.round(point.tokensAtCut / 1000)}k at cut)`)
  const gen = await claude(["--model", ANSWER_MODEL, ...NO_TOOLS], { cwd: OUT, stdin: GENERATOR + material })
  let questions: any[]
  try {
    questions = extractJson(gen.result).questions
  } catch {
    log(`question generation failed: ${String(gen.result).slice(0, 160)}`)
    return null
  }

  const vet = await claude(["--model", ORACLE_MODEL, ...NO_TOOLS], { cwd: OUT, stdin: ORACLE(questions, material) })
  const oracle: Record<string, { ok: boolean; why: string }> = {}
  try {
    for (const v of extractJson(vet.result).verdicts) oracle[String(v.id)] = { ok: v.verdict === "ok", why: v.why ?? "" }
  } catch {
    log("oracle failed; keeping every question")
  }
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
  writeFileSync(transcriptCopy, `${pre.join("\n")}\n`)
  const created: string[] = []

  const prepared = await preparePoint(point, tag, log)
  if (!prepared) return null
  const { questions, oracle, kept } = prepared
  if (kept.length < 4) {
    log("too few usable questions, skipping point")
    return null
  }
  if (PHASE === "prepare") return null

  let nativeLines: string[]
  let native = point.native
  if (point.kind === "real") {
    const all = parse(point.lines)
    const firstAfter = all.findIndex((e, i) => i > point.cutLine && e.type === "assistant" && !e.isSidechain)
    nativeLines = point.lines.slice(0, firstAfter === -1 ? point.lines.length : firstAfter)
  } else {
    log("native: running /compact")
    let file = ""
    const out = await claude(
      () => {
        if (file) rmSync(file, { force: true })
        const id = crypto.randomUUID()
        file = writeCopy(point, pre, id)
        created.push(file)
        return ["--resume", id, "--model", ANSWER_MODEL, "--settings", JSON.stringify(BASE_SETTINGS)]
      },
      { cwd: point.cwd, stdin: "/compact" },
    )
    const after = readFileSync(file, "utf8").split("\n").filter(Boolean)
    const boundary = parse(after).find((e) => e.subtype === "compact_boundary")
    if (!boundary) {
      log(`/compact produced no summary: ${String(out.result).slice(0, 160)}`)
      return null
    }
    native = { durationMs: boundary.compactMetadata?.durationMs ?? out.wallMs, preTokens: boundary.compactMetadata?.preTokens ?? 0, postTokens: boundary.compactMetadata?.postTokens }
    nativeLines = after
  }
  writeFileSync(path.join(OUT, "transcripts", `${tag}${SUFFIX}.native.jsonl`), `${nativeLines.join("\n")}\n`)
  const nativeEdit = repointSummary(transcriptCopy)

  const arms = ARMS.filter((a) => a !== "full" || (point.kind === "synthetic" && point.tokensAtCut < 700_000))
  const answers: Record<string, any> = {}
  const canon = path.join(OUT, "canon", `${tag}.json`)
  const pinned = Boolean(RUN_TAG) && arms.some((a) => a !== "native" && a !== "native+guide")
  await Promise.all(
    arms.map(async (arm) => {
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
      const out = await claude(
        () => {
          if (file) rmSync(file, { force: true })
          id = crypto.randomUUID()
          file = writeCopy(point, lines, id, isNative ? nativeEdit : shrinkUsage)
          created.push(file)
          return ["--resume", id, "--model", ANSWER_MODEL, "--permission-mode", "default", "--settings", JSON.stringify({ ...BASE_SETTINGS, autoCompactEnabled: false, env }), "--allowedTools", READ_ONLY]
        },
        { cwd: point.cwd, stdin: ANSWER(kept), env },
      )
      let parsed: any[] = []
      try {
        parsed = extractJson(out.result).answers
      } catch {}
      const requests = proxyRequests(arm, id)
      answers[arm] = {
        answers: parsed,
        raw: String(out.result ?? "").slice(0, 3000),
        error: parsed.length > 0 ? undefined : String(out.result ?? "").slice(0, 300),
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
    }),
  )
  for (const f of created) rmSync(f, { force: true })

  const answered = arms.filter((a) => answers[a].answers.length)
  const order = seededShuffle(answered, index + (REPLICATE - 1) * 1000)
  const labels = order.map((_, i) => String.fromCharCode(65 + i))
  const sets = Object.fromEntries(order.map((arm, i) => [labels[i], answers[arm].answers]))
  const grades: Record<string, Record<string, Array<{ score: number; label: string }>>> = {}
  await Promise.all(
    JUDGES.map(async (model, j) => {
      await Bun.sleep(j * 1200)
      const out = await claude(["--model", model, ...NO_TOOLS], { cwd: OUT, stdin: JUDGE(kept, sets) })
      try {
        const raw = extractJson(out.result).grades
        grades[model] = Object.fromEntries(
          order.map((arm, i) => [
            arm,
            kept.map((q) => {
              const g = (raw[labels[i]] ?? []).find((x: any) => x.id === q.id) ?? {}
              return { score: typeof g.score === "number" ? g.score : 0, label: String(g.label ?? "unknown") }
            }),
          ]),
        )
      } catch {
        log(`judge ${model} failed`)
      }
    }),
  )
  if (Object.keys(grades).length === 0) {
    log("no judge succeeded")
    return null
  }

  const result = {
    tag,
    replicate: REPLICATE,
    kind: point.kind,
    cwd: point.cwd,
    session: point.sessionId,
    cutLine: point.cutLine,
    turnsBefore: point.turnsBefore,
    tokensAtCut: point.tokensAtCut,
    skillsBeforeCut: skillsBeforeCut(point),
    native,
    questions: kept,
    allQuestions: questions,
    oracle,
    labels: Object.fromEntries(order.map((arm, i) => [arm, labels[i]])),
    answers,
    grades,
    judges: JUDGES,
    answerModel: ANSWER_MODEL,
  }
  writeFileSync(resultFile, JSON.stringify(result, null, 2))
  const totals = order.map((a) => {
    const per = JUDGES.filter((m) => grades[m]?.[a]).map((m) => grades[m][a].reduce((s, g) => s + g.score, 0))
    return `${a} ${(per.reduce((x, y) => x + y, 0) / per.length).toFixed(1)}`
  })
  log(`scores /${kept.length * 2}: ${totals.join("  ")}`)
  return result
}

export const startProxies = () =>
  spawnProxies(
    ALL_ARMS.filter((a) => ARMS.includes(a.name)),
    PROXIES,
    { window: 1_000_000 },
  )

if (import.meta.main) {
  const points = choosePoints()
  console.log(
    `${PHASE}${REPLICATE > 1 ? ` (replicate ${REPLICATE})` : ""}: ${points.length} points (${points.filter((p) => p.kind === "real").length} real, ${points.filter((p) => p.kind === "synthetic").length} synthetic) · account ${path.basename(CONFIG_DIR)} · credits ${API_KEY ? "on standby" : "none"}`,
  )
  const pointsFile = path.join(OUT, "points.json")
  const listed = points.map((p, i) => ({ tag: `p${String(i).padStart(2, "0")}`, kind: p.kind, cwd: p.cwd, session: p.sessionId, cutLine: p.cutLine, turns: p.turnsBefore, tokensAtCut: p.tokensAtCut }))
  if (existsSync(pointsFile)) {
    const fixed = JSON.parse(readFileSync(pointsFile, "utf8"))
    const mismatch = listed.findIndex((p, i) => !fixed[i] || fixed[i].session !== p.session || fixed[i].cutLine !== p.cutLine)
    if (mismatch !== -1 && mismatch < fixed.length) {
      console.error(`points.json disagrees at ${listed[mismatch].tag}; delete it to re-select`)
      process.exit(1)
    }
  } else {
    writeFileSync(pointsFile, JSON.stringify(listed, null, 2))
  }
  for (const p of listed) console.log(`  ${p.tag} ${p.kind.padEnd(9)} ${String(p.turns).padStart(4)} turns ${String(Math.round(p.tokensAtCut / 1000)).padStart(5)}k  ${p.cwd}`)
  if (PHASE === "points") process.exit(0)
  const proxies = PHASE === "run" ? startProxies() : []
  await Bun.sleep(1500)
  try {
    let next = 0
    await Promise.all(
      Array.from({ length: PARALLEL }, async () => {
        while (next < points.length) {
          const i = next++
          await runPoint(points[i], i).catch((e) => console.error(`[p${i}]`, e))
        }
      }),
    )
  } finally {
    for (const p of proxies) p.kill()
  }
  console.log("done")
}
