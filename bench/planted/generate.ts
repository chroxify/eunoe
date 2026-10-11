import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { claude } from "../lib/claude"
import { NO_TOOLS } from "../lib/constants"
import { extractJson } from "../lib/json"
import { CHUNK, CHUNK_PROMPT, CLAUDE_VERSION, GENERATOR_MODEL, OUTLINE, PLANT_OUT, REPOS, SESSIONS, STYLES, TEXT } from "./constants"
import { agoOf, type Fact, planFacts, rng, values } from "./facts"

export interface Repo {
  root: string
  name: string
  files: string[]
  readme: string
}

function repoContext(root: string): Repo {
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter((f) => TEXT.test(f) && !/(^|\/)(node_modules|dist|vendor|Pods)\//.test(f) && !f.endsWith(".lock") && !/lock\.json$/.test(f))
    .filter((f) => {
      try {
        const s = statSync(path.join(root, f)).size
        return s > 200 && s < 120_000
      } catch {
        return false
      }
    })
  const readmeFile = files.find((f) => /^readme\.md$/i.test(f)) ?? files.find((f) => /readme\.md$/i.test(f))
  const readme = readmeFile ? readFileSync(path.join(root, readmeFile), "utf8").split("\n").slice(0, 60).join("\n") : ""
  return { root, name: path.basename(root), files, readme }
}

function sampleFiles(repo: Repo, rand: () => number, n: number) {
  if (repo.files.length <= n) return repo.files
  const out = new Set<string>()
  while (out.size < n) out.add(repo.files[Math.floor(rand() * repo.files.length)])
  return [...out].sort()
}

export interface Step {
  tool: "read" | "grep" | "ls" | "git" | "edit" | "run"
  path?: string
  offset?: number
  limit?: number
  pattern?: string
  args?: string
  old?: string
  new?: string
  command?: string
  output?: string
  failed?: boolean
  say?: string
}

export interface Turn {
  turn: number
  user: string
  steps: Step[]
  reply: string
}

interface FactText {
  id: string
  question: string
  task?: string
}

function plantRule(fact: Fact, plantIndex: number): string {
  const p = fact.plants[plantIndex]
  switch (fact.type) {
    case "tool_value":
      return `Turn ${p.turn}: a "run" step's output contains exactly \`${p.value}\` as ${fact.label}. The agent must NEVER repeat or paraphrase this value in prose (no "say", no "reply"), in this turn or any other.`
    case "prose_value":
      return `Turn ${p.turn}: a "run" step's output contains exactly \`${p.value}\` as ${fact.label}, and the agent's final reply of that turn mentions it verbatim.`
    case "error":
      return `Turn ${p.turn}: a "run" step fails ("failed": true) and its output contains exactly \`${p.value}\` (${fact.label}). The agent works around or fixes it, but never quotes the code in prose.`
    case "superseded":
      return plantIndex === 0
        ? `Turn ${p.turn}: a "run" step's output shows \`${p.value}\` as ${fact.label}. Do not mention it in prose.`
        : `Turn ${p.turn}: a later "run" step's output shows a NEW value \`${p.value}\` as ${fact.label}, replacing the earlier one \`${fact.plants[0].value}\`. Never mention the old value again.`
    case "instruction":
      return `Turn ${p.turn}: the developer's message gives a standing rule, in their own words, containing \`${p.value}\` verbatim: ${fact.brief}. The agent acknowledges it in one short sentence without repeating the value. From then on the value never appears again: no later step (in these turns or any other) runs a command that would use it, and nobody mentions it.`
    case "revised":
      return plantIndex === 0
        ? `Turn ${p.turn}: the developer's message gives a standing rule, in their own words, containing \`${p.value}\` verbatim: ${fact.label} is \`${p.value}\`. The agent acknowledges it briefly without repeating the value. Afterwards the value never appears again: no later step uses it and nobody mentions it.`
        : `Turn ${p.turn}: the developer changes the earlier rule: ${fact.label} is now \`${p.value}\` instead of \`${fact.plants[0].value}\`. Their message contains both values. The agent acknowledges briefly. Afterwards neither value appears again: no later step uses either and nobody mentions them.`
    case "decision": {
      const [chosen, rejected] = p.value.split("|")
      return `Turn ${p.turn}: the agent's reply compares two approaches to a real problem in this turn's work, named exactly "${chosen}" and "${rejected}", recommends ${chosen} and explains why ${rejected} is rejected. The developer agrees in the next turn's message without naming either. Neither name appears in any other turn.`
    }
    case "promise": {
      const [from, to] = p.value.split("|")
      return `Turn ${p.turn}: the developer and agent agree to rename \`${from}\` to \`${to}\` later, not now (it's in this turn's user message or reply). Neither name appears in any other turn and the rename is never done.`
    }
  }
}

const prose = (t: Turn) => [t.user, t.reply, ...t.steps.map((s) => s.say ?? "")].join("\n")
const outputs = (t: Turn) =>
  t.steps
    .filter((s) => s.tool === "run")
    .map((s) => s.output ?? "")
    .join("\n")
const everything = (t: Turn) => JSON.stringify(t)

function plantErrors(fact: Fact, value: string, planted: Turn, where: string): string[] {
  const errors: string[] = []
  const inOutput = outputs(planted).includes(value)
  switch (fact.type) {
    case "tool_value":
      if (!inOutput) errors.push(`${where}: \`${value}\` must be in a run step's output`)
      if (prose(planted).includes(value)) errors.push(`${where}: \`${value}\` must not appear in user/say/reply`)
      break
    case "prose_value":
      if (!inOutput) errors.push(`${where}: \`${value}\` must be in a run step's output`)
      if (!planted.reply.includes(value)) errors.push(`${where}: the reply must mention \`${value}\``)
      break
    case "error":
      if (!planted.steps.some((s) => s.tool === "run" && s.failed && (s.output ?? "").includes(value))) errors.push(`${where}: a failed run step's output must contain \`${value}\``)
      if (prose(planted).includes(value)) errors.push(`${where}: \`${value}\` must not appear in prose`)
      break
    case "superseded":
      if (!inOutput) errors.push(`${where}: \`${value}\` must be in a run step's output`)
      break
    case "instruction":
    case "revised":
      if (!planted.user.includes(value)) errors.push(`${where}: the user message must contain \`${value}\` verbatim`)
      break
    case "decision":
    case "promise": {
      const spoken = planted.reply + planted.user + planted.steps.map((s) => s.say ?? "").join(" ")
      for (const part of value.split("|")) if (!spoken.includes(part)) errors.push(`${where}: \`${part}\` must appear in the user message or the reply`)
      break
    }
  }
  return errors
}

function leakErrors(fact: Fact, turns: Turn[]): string[] {
  const errors: string[] = []
  for (const value of new Set(fact.plants.flatMap((p) => p.value.split("|")))) {
    const allowed = fact.plants
      .filter((p) => p.value.split("|").includes(value))
      .map((p) => p.turn)
      .join(" and ")
    for (const t of turns) if (everything(t).includes(value) && !allowedIn(fact, value, t.turn)) errors.push(`turn ${t.turn} contains \`${value}\` (${fact.id}), which may only appear in turn ${allowed}`)
  }
  return errors
}

export function checkChunk(turns: Turn[], facts: Fact[], from: number, to: number, forbidden: string[]): string[] {
  const errors: string[] = []
  const byTurn = new Map(turns.map((t) => [t.turn, t]))
  for (let n = from; n <= to; n += 1) if (!byTurn.has(n)) errors.push(`turn ${n} is missing`)
  for (const t of turns) {
    if (!t.user?.trim() || !t.reply?.trim() || !Array.isArray(t.steps)) errors.push(`turn ${t.turn} lacks user, steps or reply`)
    for (const f of forbidden) if (everything(t).includes(f)) errors.push(`turn ${t.turn} contains \`${f}\`, which must not appear here`)
  }
  for (const fact of facts) {
    for (const p of fact.plants) {
      const planted = byTurn.get(p.turn)
      if (p.turn < from || p.turn > to || !planted) continue
      errors.push(...plantErrors(fact, p.value, planted, `turn ${p.turn} (${fact.id})`))
    }
    errors.push(...leakErrors(fact, turns))
  }
  return [...new Set(errors)]
}

const allowedIn = (fact: Fact, value: string, turn: number) => fact.plants.some((p) => p.turn === turn && p.value.split("|").includes(value)) || (fact.type === "revised" && turn === fact.plants[1].turn && value === fact.plants[0].value)

const clip = (text: string, lines: number) => {
  const all = text.split("\n")
  return all.length > lines ? `${all.slice(0, lines).join("\n")}\n... (${all.length - lines} more lines)` : text
}

function exec(command: string, args: string[], cwd: string) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] })
  } catch (error: any) {
    return String(error.stdout ?? "") + String(error.stderr ?? "")
  }
}

export function realize(step: Step, root: string): { name: string; input: Record<string, unknown>; output: string; isError: boolean } {
  const abs = (p = ".") => (path.isAbsolute(p) ? p : path.join(root, p))
  switch (step.tool) {
    case "read": {
      const file = abs(step.path)
      const offset = Math.max(1, step.offset ?? 1)
      const limit = Math.min(Math.max(20, step.limit ?? 200), 300)
      let output: string
      try {
        const lines = readFileSync(file, "utf8").split("\n")
        output = lines
          .slice(offset - 1, offset - 1 + limit)
          .map((l, i) => `${offset + i}\t${l.slice(0, 2000)}`)
          .join("\n")
      } catch {
        output = `File does not exist. Current working directory: ${root}`
        return { name: "Read", input: { file_path: file }, output, isError: true }
      }
      return { name: "Read", input: { file_path: file, offset, limit }, output, isError: false }
    }
    case "grep": {
      const target = step.path ?? "."
      const out = exec("rg", ["-n", "--max-count", "8", "--max-columns", "300", step.pattern ?? "", target], root)
      return { name: "Grep", input: { pattern: step.pattern, path: abs(target), output_mode: "content", "-n": true }, output: clip(out.trim() || "No matches found", 120), isError: false }
    }
    case "ls": {
      const out = exec("ls", ["-la", step.path ?? "."], root)
      return { name: "Bash", input: { command: `ls -la ${step.path ?? "."}`, description: "List directory" }, output: clip(out.trim(), 80), isError: false }
    }
    case "git": {
      const args = (step.args ?? "log --oneline -15").split(/\s+/).filter(Boolean)
      const safe = ["log", "show", "diff", "blame"].includes(args[0]) ? args : ["log", "--oneline", "-15"]
      const out = exec("git", ["-c", "color.ui=never", "--no-pager", ...safe], root)
      return { name: "Bash", input: { command: `git ${safe.join(" ")}`, description: "Inspect git history" }, output: clip(out.trim() || "(no output)", 150), isError: false }
    }
    case "edit":
      return { name: "Edit", input: { file_path: abs(step.path), old_string: step.old ?? "", new_string: step.new ?? "" }, output: `The file ${abs(step.path)} has been updated successfully.`, isError: false }
    default: {
      const out = step.output ?? ""
      return { name: "Bash", input: { command: step.command ?? "", description: "Run command" }, output: step.failed ? `Error: Exit code 1\n${out}` : out, isError: Boolean(step.failed) }
    }
  }
}

export function toSessionLines(turns: Turn[], o: { sessionId: string; cwd: string; model: string; start: number }): { lines: string[]; tokens: number } {
  const lines: string[] = []
  let parent: string | null = null
  let clock = o.start
  let context = 22_000
  const base = () => ({ isSidechain: false, userType: "external", entrypoint: "cli", cwd: o.cwd, sessionId: o.sessionId, version: CLAUDE_VERSION, gitBranch: "main" })
  const push = (entry: Record<string, unknown>) => {
    const uuid = crypto.randomUUID()
    clock += 1_500 + Math.floor(Math.random() * 9_000)
    lines.push(JSON.stringify({ parentUuid: parent, ...entry, uuid, timestamp: new Date(clock).toISOString(), ...base() }))
    parent = uuid
  }
  const usage = (out: number) => ({ input_tokens: 4, cache_creation_input_tokens: 1_200, cache_read_input_tokens: context, output_tokens: out, service_tier: "standard" })
  for (const turn of turns) {
    const promptId = crypto.randomUUID()
    push({ type: "user", promptId, message: { role: "user", content: turn.user } })
    context += Math.ceil(turn.user.length / 3.6)
    const messageId = () => `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
    for (const step of turn.steps) {
      const real = realize(step, o.cwd)
      const id = messageId()
      if (step.say) push({ type: "assistant", message: { model: o.model, id, type: "message", role: "assistant", content: [{ type: "text", text: step.say }], stop_reason: null, stop_sequence: null, usage: usage(40) } })
      const toolUseId = `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
      push({
        type: "assistant",
        message: { model: o.model, id, type: "message", role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: real.name, input: real.input }], stop_reason: "tool_use", stop_sequence: null, usage: usage(80) },
      })
      push({
        type: "user",
        promptId,
        message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content: real.output, ...(real.isError ? { is_error: true } : {}) }] },
        toolUseResult: real.isError ? `Error: ${real.output.slice(0, 200)}` : { stdout: real.output.slice(0, 200), stderr: "", interrupted: false },
      })
      context += Math.ceil((JSON.stringify(real.input).length + real.output.length) / 3.6) + 60
    }
    push({
      type: "assistant",
      message: { model: o.model, id: messageId(), type: "message", role: "assistant", content: [{ type: "text", text: turn.reply }], stop_reason: "end_turn", stop_sequence: null, usage: usage(Math.ceil(turn.reply.length / 3.6)) },
    })
    context += Math.ceil(turn.reply.length / 3.6)
  }
  return { lines, tokens: context }
}

export interface Meta {
  id: string
  index: number
  split: "dev" | "test"
  repo: string
  cwd: string
  title: string
  style: string
  turns: number
  tokens: number
  facts: Array<Fact & { question: string; task?: string; ago: number }>
}

function opus(prompt: string) {
  return claude(["--model", GENERATOR_MODEL, ...NO_TOOLS], { cwd: PLANT_OUT, stdin: prompt, env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000" } })
}

interface Setting {
  repo: Repo
  files: string[]
  turns: number
  style: string
}

type Progress = { title: string; topics: string[]; turns: Turn[]; facts: Record<string, FactText> }

async function buildOutline(progress: Progress, { repo, files, turns, style }: Setting, log: (m: string) => void): Promise<boolean> {
  log(`outline (${repo.name}, ${turns} turns)`)
  for (let attempt = 0; attempt < 3 && progress.topics.length !== turns; attempt += 1) {
    const out = await opus(OUTLINE(repo, files, turns, style))
    try {
      const parsed = extractJson(out.result)
      progress.title = parsed.title
      progress.topics = parsed.topics
    } catch {}
    if (progress.topics.length > turns) progress.topics = progress.topics.slice(0, turns)
    while (progress.topics.length > 0 && progress.topics.length < turns) progress.topics.push(progress.topics.at(-1)!)
  }
  return progress.topics.length === turns
}

function questionErrors(questions: Fact[], factTexts: FactText[]): string[] {
  const errors: string[] = []
  for (const f of questions) {
    const text = factTexts.find((x) => x.id === f.id)
    if (!text?.question) errors.push(`missing question for ${f.id}`)
    const leaks = [f.answer, ...(f.stale ? [f.stale] : [])].filter((a) => text && `${text.question} ${text.task ?? ""}`.includes(a))
    if (leaks.length > 0) errors.push(`the question or task for ${f.id} reveals a value (${leaks.join(", ")})`)
    if (f.implicit && !text?.task) errors.push(`missing task for ${f.id}`)
  }
  return errors
}

const chunkTurnsOf = (parsed: any, from: number): Turn[] =>
  (parsed.turns ?? []).map((t: any, i: number) => ({ turn: Number(t.turn ?? from + i), user: String(t.user ?? ""), steps: Array.isArray(t.steps) ? t.steps : [], reply: String(t.reply ?? "") }))

async function generateChunk(setting: Setting, progress: Progress, facts: Fact[], from: number, to: number, log: (m: string) => void): Promise<{ turns: Turn[]; facts: FactText[] } | null> {
  const { repo, files, style, turns } = setting
  const inChunk = (turn: number) => turn >= from && turn <= to
  const rules = facts.flatMap((f) => f.plants.map((p, i) => (inChunk(p.turn) ? plantRule(f, i) : ""))).filter(Boolean)
  const questions = facts.filter((f) => inChunk(f.plants.at(-1)!.turn))
  const span = Array.from({ length: to - from + 1 }, (_, k) => from + k)
  const forbidden = [...new Set(facts.flatMap((f) => f.plants.flatMap((p) => p.value.split("|"))))].filter((value) => !facts.some((f) => span.some((turn) => allowedIn(f, value, turn))))
  let feedback: string | undefined
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const out = await opus(CHUNK_PROMPT({ repo, files, style, title: progress.title, topics: progress.topics.slice(from - 1, to), from, to, turns, recent: progress.turns.slice(-4), rules, questions, forbidden, feedback }))
    let parsed: any
    try {
      parsed = extractJson(out.result)
    } catch {
      const text = String(out.result ?? "")
      log(`turns ${from}-${to}: attempt ${attempt + 1} unparseable (${text.length} chars: ${text.slice(0, 120).replace(/\s+/g, " ")} … ${text.slice(-80).replace(/\s+/g, " ")})`)
      if (/usage limit|rate limit|overloaded|429|529/i.test(text) && text.length < 2_000) await Bun.sleep(60_000 * (attempt + 1))
      feedback = "The reply was not valid JSON. Return only the JSON object."
      continue
    }
    const chunkTurns = chunkTurnsOf(parsed, from)
    const factTexts: FactText[] = parsed.facts ?? []
    const errors = [...checkChunk(chunkTurns, facts, from, to, forbidden), ...questionErrors(questions, factTexts)]
    if (errors.length === 0) return { turns: chunkTurns.sort((a, b) => a.turn - b.turn), facts: factTexts }
    feedback = errors.map((e) => `- ${e}`).join("\n")
    log(`turns ${from}-${to}: attempt ${attempt + 1} rejected (${errors.length}: ${errors[0].slice(0, 90)})`)
  }
  return null
}

export async function generateSession(index: number, log: (m: string) => void): Promise<Meta | null> {
  const id = `s${String(index).padStart(2, "0")}`
  const metaFile = path.join(SESSIONS, `${id}.meta.json`)
  if (existsSync(metaFile)) return JSON.parse(readFileSync(metaFile, "utf8"))
  const progressFile = path.join(SESSIONS, `${id}.progress.json`)
  const rand = rng(9_100 + index * 131)
  const v = values(rand)
  const repo = repoContext(REPOS[index % REPOS.length])
  const turns = v.int(90, 120)
  const style = STYLES[index % STYLES.length]
  const facts = planFacts({ seed: 77_000 + index * 977, turns })
  const setting: Setting = { repo, files: sampleFiles(repo, rand, 260), turns, style }

  const progress: Progress = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, "utf8")) : { title: "", topics: [], turns: [], facts: {} }
  if (progress.topics.length === 0) {
    if (!(await buildOutline(progress, setting, log))) {
      log("outline failed")
      return null
    }
    writeFileSync(progressFile, JSON.stringify(progress))
  }

  for (let from = progress.turns.length + 1; from <= turns; from += CHUNK) {
    const to = Math.min(turns, from + CHUNK - 1)
    const accepted = await generateChunk(setting, progress, facts, from, to, log)
    if (!accepted) {
      log(`turns ${from}-${to}: gave up`)
      return null
    }
    progress.turns.push(...accepted.turns)
    for (const f of accepted.facts) progress.facts[f.id] = f
    writeFileSync(progressFile, JSON.stringify(progress))
    log(`turns ${from}-${to} ok`)
  }

  const errors = checkChunk(progress.turns, facts, 1, turns, [])
  if (errors.length > 0) {
    log(`whole-session check failed: ${errors.slice(0, 3).join("; ")}`)
    return null
  }

  const sessionId = crypto.randomUUID()
  const { lines, tokens } = toSessionLines(progress.turns, { sessionId, cwd: repo.root, model: GENERATOR_MODEL, start: Date.parse("2026-09-01T09:00:00Z") + index * 86_400_000 })
  writeFileSync(path.join(SESSIONS, `${id}.jsonl`), `${lines.join("\n")}\n`)
  writeFileSync(path.join(SESSIONS, `${id}.turns.json`), JSON.stringify(progress.turns, null, 1))
  const meta: Meta = {
    id,
    index,
    split: index % 3 === 0 ? "dev" : "test",
    repo: repo.name,
    cwd: repo.root,
    title: progress.title,
    style,
    turns,
    tokens,
    facts: facts.map((f) => ({ ...f, question: progress.facts[f.id]?.question ?? "", task: progress.facts[f.id]?.task, ago: agoOf(f, turns) })),
  }
  writeFileSync(metaFile, JSON.stringify(meta, null, 2))
  log(`done: ${turns} turns, ~${Math.round(tokens / 1000)}k tokens`)
  return meta
}

if (import.meta.main) {
  mkdirSync(SESSIONS, { recursive: true })
  const nums = process.argv
    .slice(2)
    .filter((a) => /^\d+$/.test(a))
    .map(Number)
  const count = nums[0] ?? 36
  const parallel = nums[1] ?? 6
  const only = process.argv
    .slice(2)
    .find((a) => a.startsWith("--only="))
    ?.slice(7)
    .split(",")
    .map(Number)
  const queue = only ?? Array.from({ length: count }, (_, i) => i)
  let next = 0
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < queue.length) {
        const i = queue[next++]
        const tag = `s${String(i).padStart(2, "0")}`
        await generateSession(i, (m) => console.log(`[${tag}] ${m}`)).catch((e) => console.error(`[${tag}]`, e))
      }
    }),
  )
  console.log("done")
}
