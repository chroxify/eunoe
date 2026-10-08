/**
 * Runs context strategies ("arms") on planted sessions and scores them by
 * exact match against the planted values. No judge: a fact counts when the
 * planted value is in the answer, a revised fact counts as stale when only
 * the old value is.
 *
 * Every arm resumes the same session through its own eunoe proxy and gets two
 * messages, in this order:
 *   1. tasks:    requests that can only be done right by applying an earlier
 *                instruction, without mentioning it (does it use what it knows?)
 *   2. recall:   one question per planted fact (does it know it?)
 *
 * Every arm sends the same system prompt and tools (the proxy's canonical
 * header), so the only thing that differs is the conversation each arm keeps.
 *
 *   bun bench/planted/run.ts [--split=dev|test|all] [--arms=a,b,c] [--sessions=s00,s03] [--parallel=3] [--tag=name]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { extractJson } from "../lib/json"
import { ARMS, type ArmSpec } from "../arms"
import { BASE_SETTINGS, READ_ONLY, claude, projectDir } from "../lib/claude"
import { blocks, parse, textOf } from "../lib/points"
import { startProxies as spawnProxies } from "../lib/proxy"
import { lookupsAfterQuestion } from "../real/run"
import { PLANT_OUT, SESSIONS, type Meta } from "./generate"

export const ANSWER_MODEL = "claude-sonnet-5-5"
export const RUNS = path.join(PLANT_OUT, "runs")
const NATIVE = path.join(PLANT_OUT, "native")
const CANON = path.join(PLANT_OUT, "canon")
const TRANSCRIPTS = path.join(PLANT_OUT, "transcripts")
const CUT_SHARE = 0.95

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

// ---------------------------------------------------------------- prompts

export const TASKS = (facts: Meta["facts"]) => `A few quick things before we carry on. Don't run or change anything for these, just answer each one in a sentence or two, as you actually would do it right now.

${facts.map((f) => `${f.id}. ${f.task}`).join("\n")}

Reply with only JSON: {"replies":[{"id":"${facts[0]?.id}","reply":"..."}, ...]}`

export const RECALL = (facts: Meta["facts"]) => `Stop the current work for a moment: this is a memory check about this session. Do not continue the task and do not change anything.

Answer each question about what happened earlier in this session. Use what is in your context. If it isn't there and you know where this session's transcript is, search it (read-only). Do not inspect the project's files or git history to reconstruct answers; they must come from this conversation. If you don't know, answer "unknown" rather than guessing.

Give only the exact value each question asks for (an ID, a number, a name, a flag, a prefix), copied exactly, with no explanation.

${facts.map((f) => `${f.id}. ${f.question}`).join("\n")}

Reply with only JSON: {"answers":[{"id":"${facts[0]?.id}","answer":"..."}, ...]}`

// ---------------------------------------------------------------- scoring

export const norm = (text: string) => String(text ?? "").toLowerCase().replace(/[`'"“”‘’]/g, "").replace(/(\d),(\d{3})/g, "$1$2").replace(/\s+/g, " ").trim()

export type Verdict = "correct" | "stale" | "wrong" | "unknown"

// A stale value mentioned as history ("replaced the old pennix/", "not
// @beltor27") is not a use of it. Only an unframed mention counts.
const SUPERSEDED_BEFORE = /(?:old|older|previous|former|earlier|replac\w*|instead of|rather than|no longer|not|n.t|over|from|was|were|used to|superseded|dropped|rejected|ruled out|than)\W*(?:\w+\W+){0,4}$/
const SUPERSEDED_AFTER = /^\W*(?:\w+\W+){0,3}?(?:is|was|has been|got)?\W*(?:no longer|replaced|superseded|retired|dropped|rejected|out|old|obsolete|deprecated)\b/

export function usesUnframed(said: string, value: string): boolean {
  const needle = norm(value)
  for (let at = said.indexOf(needle); at !== -1; at = said.indexOf(needle, at + 1)) {
    const before = said.slice(Math.max(0, at - 50), at)
    const after = said.slice(at + needle.length, at + needle.length + 40)
    if (!SUPERSEDED_BEFORE.test(before) && !SUPERSEDED_AFTER.test(after)) return true
  }
  return false
}

export function verdict(fact: Meta["facts"][number], response: string | undefined): Verdict {
  const said = norm(response ?? "")
  if (!said || /^(unknown|i don.?t know|not sure|n\/a|none)\.?$/.test(said)) return "unknown"
  const has = (value: string) => said.includes(norm(value))
  const usesStale = () => Boolean(fact.stale) && usesUnframed(said, fact.stale!)
  if (fact.type === "decision") return has(fact.answer) && !usesStale() ? "correct" : has(fact.stale!) && !has(fact.answer) ? "stale" : "wrong"
  if (has(fact.answer)) return usesStale() ? "wrong" : "correct"
  if (fact.stale && has(fact.stale)) return "stale"
  return /unknown|don.?t know|not (?:sure|in (?:my )?context)|can.?t (?:find|tell)|no record/.test(said) ? "unknown" : "wrong"
}

// ---------------------------------------------------------------- session copies

function writeCopy(cwd: string, lines: string[], id: string, edit?: (e: any) => any) {
  const file = path.join(projectDir(cwd), `${id}.jsonl`)
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

const shrinkUsage = (e: any) => {
  if (e.message?.usage) e.message.usage = { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: e.message.usage.output_tokens ?? 0 }
  return e
}

function repointSummary(transcript: string) {
  return (e: any) => {
    if (!e.isCompactSummary) return e
    const swap = (s: string) => s.replace(/(read the full transcript at:\s*)\S+/g, `$1${transcript}`)
    const c = e.message.content
    e.message.content = typeof c === "string" ? swap(c) : c.map((b: any) => (b.type === "text" ? { ...b, text: swap(b.text) } : b))
    return e
  }
}

/** Claude Code's own compaction of the session, made once and reused by every run. */
async function nativeCopy(meta: Meta, lines: string[], log: (m: string) => void): Promise<string[] | null> {
  const file = path.join(NATIVE, `${meta.id}.jsonl`)
  if (existsSync(file)) return readFileSync(file, "utf8").split("\n").filter(Boolean)
  log("native: running /compact")
  let copy = ""
  const out = await claude(() => {
    if (copy) rmSync(copy, { force: true })
    const id = crypto.randomUUID()
    copy = writeCopy(meta.cwd, lines, id)
    return ["--resume", id, "--model", ANSWER_MODEL, "--settings", JSON.stringify(BASE_SETTINGS)]
  }, { cwd: meta.cwd, stdin: "/compact" })
  const after = readFileSync(copy, "utf8").split("\n").filter(Boolean)
  rmSync(copy, { force: true })
  const boundary = parse(after).find((e) => e.subtype === "compact_boundary")
  if (!boundary) { log(`/compact produced no summary: ${String(out.result).slice(0, 200)}`); return null }
  mkdirSync(NATIVE, { recursive: true })
  writeFileSync(file, after.join("\n") + "\n")
  return after
}

// ---------------------------------------------------------------- one arm

export interface ArmResult {
  arm: string
  replies: Record<string, string>
  answers: Record<string, string>
  tasks: Record<string, Verdict>
  recall: Record<string, Verdict>
  lookups: ReturnType<typeof lookupsAfterQuestion>
  requests: number
  contextAtTasks: number | null
  contextAtRecall: number | null
  tokensProcessed: number
  cacheRead: number
  cacheWrite: number
  wallMs: number
  notes: string[]
  errors: string[]
}

function proxyLog(spec: ArmSpec, session: string) {
  const file = path.join(RUNS, "proxies", spec.proxy, "requests.jsonl")
  if (!existsSync(file)) return [] as any[]
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } })
    .filter((r) => String(r.thread ?? "").startsWith(session) || r.context?.session === session)
}

async function runArm(meta: Meta, spec: ArmSpec, lines: string[], native: string[], log: (m: string) => void): Promise<ArmResult> {
  const transcript = path.join(TRANSCRIPTS, `${meta.id}.jsonl`)
  const window = Math.round(meta.tokens / CUT_SHARE)
  const headers = [`x-eunoe-transcript: ${transcript}`, `x-eunoe-canonical: ${path.join(CANON, `${meta.id}.json`)}`, ...(spec.uncut ? [] : [`x-eunoe-window: ${window}`])]
  const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${spec.port}`, ANTHROPIC_CUSTOM_HEADERS: headers.join("\n") }
  const source = spec.native ? native : lines
  const edit = spec.native ? repointSummary(transcript) : shrinkUsage
  const settings = JSON.stringify({ ...BASE_SETTINGS, autoCompactEnabled: false, env })
  const started = Date.now()
  let id = ""
  let file = ""
  const fresh = () => {
    if (file) rmSync(file, { force: true })
    id = crypto.randomUUID()
    file = writeCopy(meta.cwd, source, id, edit)
    return ["--resume", id, "--model", ANSWER_MODEL, "--permission-mode", "default", "--settings", settings, "--allowedTools", READ_ONLY]
  }
  const implicit = meta.facts.filter((f) => f.implicit && f.task)
  const errors: string[] = []
  const first = await claude(fresh, { cwd: meta.cwd, stdin: TASKS(implicit), env })
  let replies: Record<string, string> = {}
  try { replies = Object.fromEntries(extractJson(first.result).replies.map((r: any) => [String(r.id), String(r.reply ?? "")])) } catch { errors.push(`tasks: ${String(first.result).slice(0, 200)}`) }
  const recallStart = new Date().toISOString()
  const second = await claude(["--resume", id, "--model", ANSWER_MODEL, "--permission-mode", "default", "--settings", settings, "--allowedTools", READ_ONLY], { cwd: meta.cwd, stdin: RECALL(meta.facts), env })
  let answers: Record<string, string> = {}
  try { answers = Object.fromEntries(extractJson(second.result).answers.map((a: any) => [String(a.id), String(a.answer ?? "")])) } catch { errors.push(`recall: ${String(second.result).slice(0, 200)}`) }
  const lookups = lookupsAfterQuestion(file, meta.cwd)
  rmSync(file, { force: true })
  const requests = proxyLog(spec, id)
  const inputs = requests.filter((r) => r.input)
  log(`${spec.name}: ${Object.keys(answers).length} answers, ${Object.keys(replies).length} replies, ${lookups.calls} lookups, ${Math.round((Date.now() - started) / 1000)}s`)
  return {
    arm: spec.name,
    replies,
    answers,
    tasks: Object.fromEntries(implicit.map((f) => [f.id, verdict(f, replies[f.id])])),
    recall: Object.fromEntries(meta.facts.map((f) => [f.id, verdict(f, answers[f.id])])),
    lookups,
    requests: requests.length,
    contextAtTasks: inputs[0]?.input ?? null,
    contextAtRecall: inputs.find((r) => r.ts >= recallStart)?.input ?? null,
    tokensProcessed: inputs.reduce((s, r) => s + (r.input ?? 0), 0),
    cacheRead: inputs.reduce((s, r) => s + (r.cacheRead ?? 0), 0),
    cacheWrite: inputs.reduce((s, r) => s + (r.cacheWrite ?? 0), 0),
    wallMs: Date.now() - started,
    notes: [...new Set(requests.map((r) => r.action).filter(Boolean))],
    errors,
  }
}

// ---------------------------------------------------------------- one session

async function runSession(meta: Meta, specs: ArmSpec[], tag: string) {
  const log = (m: string) => console.log(`[${meta.id} ${meta.repo}] ${m}`)
  const dir = path.join(RUNS, tag)
  mkdirSync(dir, { recursive: true })
  const lines = readFileSync(path.join(SESSIONS, `${meta.id}.jsonl`), "utf8").split("\n").filter(Boolean)
  mkdirSync(TRANSCRIPTS, { recursive: true })
  writeFileSync(path.join(TRANSCRIPTS, `${meta.id}.jsonl`), lines.join("\n") + "\n")
  const todo = specs.filter((s) => !existsSync(path.join(dir, `${meta.id}.${s.name}.json`)))
  if (!todo.length) return
  const native = todo.some((s) => s.native) ? await nativeCopy(meta, lines, log) : []
  if (!native) return
  // Canonical system prompt and tools come from an arm that resumes the
  // uncompacted session (what a live user's session sends), so native arms
  // start only once it exists.
  const canon = path.join(CANON, `${meta.id}.json`)
  mkdirSync(CANON, { recursive: true })
  const save = (r: ArmResult) => writeFileSync(path.join(dir, `${meta.id}.${r.arm}.json`), JSON.stringify(r, null, 2))
  const plain = todo.filter((s) => !s.native)
  const natives = todo.filter((s) => s.native)
  const capture = existsSync(canon) ? Promise.resolve() : (async () => { while (!existsSync(canon)) await Bun.sleep(1_000) })()
  if (!plain.length && !existsSync(canon)) {
    log("no canonical prompt yet; running the full arm to capture it")
    plain.push(ARMS.find((a) => a.name === "full")!)
  }
  await Promise.all([
    ...plain.map((s) => runArm(meta, s, lines, native, log).then((r) => (todo.includes(s) ? save(r) : undefined))),
    capture.then(() => Promise.all(natives.map((s) => runArm(meta, s, lines, native, log).then(save)))),
  ])
}

// ---------------------------------------------------------------- proxies

export const startProxies = (specs: ArmSpec[]) => spawnProxies(specs, path.join(RUNS, "proxies"))

export function loadMetas(split: string, only?: string[]): Meta[] {
  if (!existsSync(SESSIONS)) return []
  return Array.from(new Bun.Glob("s*.meta.json").scanSync({ cwd: SESSIONS })).sort()
    .map((f) => JSON.parse(readFileSync(path.join(SESSIONS, f), "utf8")) as Meta)
    .filter((m) => (split === "all" || m.split === split) && (!only || only.includes(m.id)))
}

if (import.meta.main) {
  const split = arg("split") ?? "dev"
  const names = (arg("arms") ?? "native,native+guide,full,tail,eunoe,rolling,trim").split(",")
  const specs = names.map((n) => ARMS.find((a) => a.name === n) ?? (() => { throw new Error(`unknown arm ${n}`) })())
  const metas = loadMetas(split, arg("sessions")?.split(","))
  const parallel = Number(arg("parallel") ?? 3)
  const tag = arg("tag") ?? "main"
  console.log(`${metas.length} ${split} sessions × ${specs.length} arms (${names.join(", ")}) → runs/${tag}`)
  const proxies = startProxies([...specs, ARMS.find((a) => a.name === "full")!])
  await Bun.sleep(1500)
  try {
    let next = 0
    await Promise.all(Array.from({ length: parallel }, async () => {
      while (next < metas.length) {
        const meta = metas[next++]
        await runSession(meta, specs, tag).catch((e) => console.error(`[${meta.id}]`, e))
      }
    }))
  } finally {
    proxies.forEach((p) => p.kill())
  }
  console.log("done")
}
