/**
 * Builds planted sessions: long, realistic Claude Code sessions on real
 * repositories with facts hidden at known depths.
 *
 * Who writes what:
 *   - code draws every planted value (facts.ts), so ground truth exists first
 *   - Opus writes the story: the developer's messages, the agent's steps and
 *     replies, the output of commands that change things, and the questions
 *   - read-only steps (reading files, grep, ls, git log) are executed for real
 *     on the repository, so most of the context is genuine code
 *   - code verifies every plant landed exactly where the plan says and nowhere
 *     else, and retries a chunk with the failures listed when it did not
 *
 *   bun bench/plant/generate.ts [count] [parallel]
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { extractJson } from "../lib/json"
import { NO_TOOLS, claude } from "../lib/claude"
import { agoOf, planFacts, rng, values, type Fact } from "./facts"

export const PLANT_OUT = path.join(import.meta.dir, "..", "out", "planted")
export const SESSIONS = path.join(PLANT_OUT, "sessions")
const GENERATOR_MODEL = "claude-opus-5-5"
const CHUNK = 12
const CLAUDE_VERSION = "2.1.287"
const PROJECTS = path.join(homedir(), "Developer", "Projects")
const SUPERWALL = path.join(homedir(), "Developer", "Superwall")
export const REPOS = [
  path.join(PROJECTS, "kanna"), path.join(PROJECTS, "buzzkit"), path.join(PROJECTS, "cs"), path.join(PROJECTS, "feedbase"),
  path.join(PROJECTS, "marcato"), path.join(PROJECTS, "outpost"), path.join(PROJECTS, "tripline"), path.join(PROJECTS, "madori"),
  path.join(PROJECTS, "sen"), path.join(PROJECTS, "shinsa"), path.join(SUPERWALL, "pwn"), path.join(SUPERWALL, "ios"),
]
const STYLES = [
  "terse and lowercase, few words, occasional typos, no greetings",
  "clear full sentences, polite, explains the why behind requests",
  "mixed: sometimes a one-liner, sometimes a paragraph of context; casual, a bit impatient",
]
const TEXT = /\.(ts|tsx|js|jsx|mjs|swift|py|go|rs|md|json|css|scss|html|yml|yaml|toml|sql|sh|kt)$/

// ---------------------------------------------------------------- repository

interface Repo {
  root: string
  name: string
  files: string[]
  readme: string
}

function repoContext(root: string): Repo {
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n").filter((f) => TEXT.test(f) && !/(^|\/)(node_modules|dist|vendor|Pods)\//.test(f) && !f.endsWith(".lock") && !/lock\.json$/.test(f))
    .filter((f) => { try { const s = statSync(path.join(root, f)).size; return s > 200 && s < 120_000 } catch { return false } })
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

// ---------------------------------------------------------------- story

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

const OUTLINE = (repo: Repo, files: string[], turns: number, style: string) => `You are planning a realistic, long working session between a developer and a coding agent (Claude Code) in the repository "${repo.name}". It runs ${turns} turns: each turn is one message from the developer and the agent's work on it.

Make it feel like a real day of work on THIS codebase: a few threads of feature work, a debugging detour or two, refactors, test runs, small chores, a release or deploy, questions about how something works. Threads continue across many turns and some get interrupted and resumed later. Topics should reference real files and areas from the list below.

The developer's style: ${style}.

Return only JSON: {"title":"...","topics":["<turn 1 topic in one line>", ... exactly ${turns} items]}

README (start):
${repo.readme.slice(0, 3000)}

Files (sample):
${files.join("\n")}`

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

const CHUNK_PROMPT = (o: {
  repo: Repo
  files: string[]
  style: string
  title: string
  topics: string[]
  from: number
  to: number
  turns: number
  recent: Turn[]
  rules: string[]
  questions: Fact[]
  forbidden: string[]
  feedback?: string
}) => `You are writing part of a realistic transcript of a long working session between a developer and a coding agent (Claude Code) in the repository "${o.repo.name}" (session: "${o.title}", ${o.turns} turns in total). Write turns ${o.from} to ${o.to}.

For each turn write:
- "user": the developer's message. Style: ${o.style}.
- "steps": the agent's tool calls, 2-6 per turn, in order. Each is one of:
    {"tool":"read","path":"<a file from the list>","offset":1,"limit":120}   executed for real, so use real paths
    {"tool":"grep","pattern":"<regex>","path":"<dir or file>"}                  executed for real
    {"tool":"ls","path":"<dir>"}                                               executed for real
    {"tool":"git","args":"log --oneline -15 | show --stat HEAD~2 | diff --stat HEAD~3"} executed for real (log, show, diff, blame only)
    {"tool":"edit","path":"<file>","old":"<a few lines>","new":"<a few lines>"}   a code change; keep old/new short
    {"tool":"run","command":"<shell command>","output":"<its output>","failed":false}  anything else: tests, builds, scripts, deploys, curl, logs. YOU write the output: realistic and substantial (15-60 lines), matching this stack.
  Any step may carry "say": one short sentence of narration the agent writes before it.
  Prefer reading 1-3 real files per turn; reads are what make the session long.
- "reply": the agent's final message for the turn, 2-6 sentences, specific about what it found or changed.

Continuity: follow the topics, keep threads consistent, refer back naturally. The developer sometimes changes direction.

Topics for these turns:
${o.topics.map((t, i) => `${o.from + i}. ${t}`).join("\n")}

${o.recent.length ? `The previous turns, for continuity:\n${o.recent.map((t) => `[${t.turn}] USER: ${t.user.slice(0, 300)}\nAGENT: ${t.reply.slice(0, 300)}`).join("\n")}\n` : ""}
These exact requirements MUST hold (they are checked by code; a miss rejects the whole chunk). Each planted value lives only in its own turn: the work in other turns must not touch what would use it (if a rule is about how tests run, later turns don't run that test suite; if it's about branches, later turns don't create branches), so nothing ever repeats it.
${o.rules.length ? o.rules.map((r) => `- ${r}`).join("\n") : "- (none in these turns)"}
- These strings must not appear anywhere in these turns: ${o.forbidden.length ? o.forbidden.map((f) => `\`${f}\``).join(", ") : "(none)"}

${o.questions.length ? `For each of these facts, also write the question a teammate would ask much later to check the agent still knows it. Phrase it in the story's own terms (what was being done, which command, which thread) so it has exactly one answer, WITHOUT revealing the answer, the turn number, or any of the values above.${o.questions.some((f) => f.implicit) ? ` For the ones marked IMPLICIT, also write "task": a natural request that can only be done right by applying the rule, without mentioning the rule (e.g. "spin up the dev server for me, what exact command will you run?").` : ""}
${o.questions.map((f) => `- ${f.id}${f.implicit ? " IMPLICIT" : ""}: ${f.label}${f.type === "revised" || f.type === "superseded" ? " (the current one)" : ""}`).join("\n")}
` : ""}${o.feedback ? `\nYour previous attempt was rejected for these reasons; fix them:\n${o.feedback}\n` : ""}
Return only JSON: {"turns":[{"turn":${o.from},"user":"...","steps":[...],"reply":"..."}, ...]${o.questions.length ? `,"facts":[{"id":"f01","question":"..."${o.questions.some((f) => f.implicit) ? `,"task":"..."` : ""}}]` : ""}}

Files you can read (sample of the repository):
${o.files.join("\n")}`

// ---------------------------------------------------------------- checks

const prose = (t: Turn) => [t.user, t.reply, ...t.steps.map((s) => s.say ?? "")].join("\n")
const outputs = (t: Turn) => t.steps.filter((s) => s.tool === "run").map((s) => s.output ?? "").join("\n")
const everything = (t: Turn) => JSON.stringify(t)

/** Every plant in these turns, checked against the plan. Returns the failures. */
export function checkChunk(turns: Turn[], facts: Fact[], from: number, to: number, forbidden: string[]): string[] {
  const errors: string[] = []
  const byTurn = new Map(turns.map((t) => [t.turn, t]))
  for (let n = from; n <= to; n += 1) if (!byTurn.has(n)) errors.push(`turn ${n} is missing`)
  for (const t of turns) {
    if (!t.user?.trim() || !t.reply?.trim() || !Array.isArray(t.steps)) errors.push(`turn ${t.turn} lacks user, steps or reply`)
    for (const f of forbidden) if (everything(t).includes(f)) errors.push(`turn ${t.turn} contains \`${f}\`, which must not appear here`)
  }
  for (const fact of facts) {
    fact.plants.forEach((p, i) => {
      if (p.turn < from || p.turn > to) return
      const t = byTurn.get(p.turn)
      if (!t) return
      const values = p.value.split("|")
      const where = `turn ${p.turn} (${fact.id})`
      switch (fact.type) {
        case "tool_value":
          if (!outputs(t).includes(p.value)) errors.push(`${where}: \`${p.value}\` must be in a run step's output`)
          if (prose(t).includes(p.value)) errors.push(`${where}: \`${p.value}\` must not appear in user/say/reply`)
          break
        case "prose_value":
          if (!outputs(t).includes(p.value)) errors.push(`${where}: \`${p.value}\` must be in a run step's output`)
          if (!t.reply.includes(p.value)) errors.push(`${where}: the reply must mention \`${p.value}\``)
          break
        case "error":
          if (!t.steps.some((s) => s.tool === "run" && s.failed && (s.output ?? "").includes(p.value))) errors.push(`${where}: a failed run step's output must contain \`${p.value}\``)
          if (prose(t).includes(p.value)) errors.push(`${where}: \`${p.value}\` must not appear in prose`)
          break
        case "superseded":
          if (!outputs(t).includes(p.value)) errors.push(`${where}: \`${p.value}\` must be in a run step's output`)
          break
        case "instruction":
          if (!t.user.includes(p.value)) errors.push(`${where}: the user message must contain \`${p.value}\` verbatim`)
          break
        case "revised":
          if (!t.user.includes(p.value)) errors.push(`${where}: the user message must contain \`${p.value}\` verbatim`)
          break
        case "decision":
        case "promise":
          for (const v of values) if (!(t.reply + t.user + t.steps.map((s) => s.say ?? "").join(" ")).includes(v)) errors.push(`${where}: \`${v}\` must appear in the user message or the reply`)
          break
      }
    })
    // Every value of every fact appears only in the turns the plan allows.
    for (const value of new Set(fact.plants.flatMap((p) => p.value.split("|")))) {
      for (const t of turns) {
        if (everything(t).includes(value) && !allowedIn(fact, value, t.turn)) {
          errors.push(`turn ${t.turn} contains \`${value}\` (${fact.id}), which may only appear in turn ${fact.plants.filter((p) => p.value.split("|").includes(value)).map((p) => p.turn).join(" and ")}`)
        }
      }
    }
  }
  return [...new Set(errors)]
}

const allowedIn = (fact: Fact, value: string, turn: number) =>
  fact.plants.some((p) => p.turn === turn && p.value.split("|").includes(value)) ||
  (fact.type === "revised" && turn === fact.plants[1].turn && value === fact.plants[0].value)

// ---------------------------------------------------------------- execution

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

/** What Claude Code would have recorded for this step: the tool call and its result. */
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
        output = lines.slice(offset - 1, offset - 1 + limit).map((l, i) => `${offset + i}\t${l.slice(0, 2000)}`).join("\n")
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
    case "run":
    default: {
      const out = step.output ?? ""
      return { name: "Bash", input: { command: step.command ?? "", description: "Run command" }, output: step.failed ? `Error: Exit code 1\n${out}` : out, isError: Boolean(step.failed) }
    }
  }
}

// ---------------------------------------------------------------- session file

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
      push({ type: "assistant", message: { model: o.model, id, type: "message", role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: real.name, input: real.input }], stop_reason: "tool_use", stop_sequence: null, usage: usage(80) } })
      push({ type: "user", promptId, message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content: real.output, ...(real.isError ? { is_error: true } : {}) }] }, toolUseResult: real.isError ? `Error: ${real.output.slice(0, 200)}` : { stdout: real.output.slice(0, 200), stderr: "", interrupted: false } })
      context += Math.ceil((JSON.stringify(real.input).length + real.output.length) / 3.6) + 60
    }
    push({ type: "assistant", message: { model: o.model, id: messageId(), type: "message", role: "assistant", content: [{ type: "text", text: turn.reply }], stop_reason: "end_turn", stop_sequence: null, usage: usage(Math.ceil(turn.reply.length / 3.6)) } })
    context += Math.ceil(turn.reply.length / 3.6)
  }
  return { lines, tokens: context }
}

// ---------------------------------------------------------------- one session

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

async function opus(prompt: string) {
  return claude(["--model", GENERATOR_MODEL, ...NO_TOOLS], { cwd: PLANT_OUT, stdin: prompt, env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000" } })
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
  const files = sampleFiles(repo, rand, 260)

  let progress: { title: string; topics: string[]; turns: Turn[]; facts: Record<string, FactText> } = existsSync(progressFile)
    ? JSON.parse(readFileSync(progressFile, "utf8"))
    : { title: "", topics: [], turns: [], facts: {} }
  if (!progress.topics.length) {
    log(`outline (${repo.name}, ${turns} turns)`)
    for (let attempt = 0; attempt < 3 && progress.topics.length !== turns; attempt += 1) {
      const out = await opus(OUTLINE(repo, files, turns, style))
      try {
        const parsed = extractJson(out.result)
        progress.title = parsed.title
        progress.topics = parsed.topics
      } catch {}
      if (progress.topics.length > turns) progress.topics = progress.topics.slice(0, turns)
      while (progress.topics.length && progress.topics.length < turns) progress.topics.push(progress.topics.at(-1)!)
    }
    if (progress.topics.length !== turns) { log("outline failed"); return null }
    writeFileSync(progressFile, JSON.stringify(progress))
  }

  for (let from = progress.turns.length + 1; from <= turns; from += CHUNK) {
    const to = Math.min(turns, from + CHUNK - 1)
    const inChunk = (turn: number) => turn >= from && turn <= to
    const rules = facts.flatMap((f) => f.plants.map((p, i) => (inChunk(p.turn) ? plantRule(f, i) : ""))).filter(Boolean)
    const questions = facts.filter((f) => inChunk(f.plants.at(-1)!.turn))
    // Values planted before this chunk, and stale values, must not come back.
    const forbidden = [...new Set(facts.flatMap((f) => f.plants.flatMap((p) => p.value.split("|"))))]
      .filter((value) => !facts.some((f) => Array.from({ length: to - from + 1 }, (_, k) => from + k).some((turn) => allowedIn(f, value, turn))))
    let feedback: string | undefined
    let accepted: { turns: Turn[]; facts: FactText[] } | null = null
    for (let attempt = 0; attempt < 4 && !accepted; attempt += 1) {
      const out = await opus(CHUNK_PROMPT({ repo, files, style, title: progress.title, topics: progress.topics.slice(from - 1, to), from, to, turns, recent: progress.turns.slice(-4), rules, questions, forbidden, feedback }))
      let parsed: any
      try { parsed = extractJson(out.result) } catch {
        const text = String(out.result ?? "")
        log(`turns ${from}-${to}: attempt ${attempt + 1} unparseable (${text.length} chars: ${text.slice(0, 120).replace(/\s+/g, " ")} … ${text.slice(-80).replace(/\s+/g, " ")})`)
        if (/usage limit|rate limit|overloaded|429|529/i.test(text) && text.length < 2_000) await Bun.sleep(60_000 * (attempt + 1))
        feedback = "The reply was not valid JSON. Return only the JSON object."
        continue
      }
      const chunkTurns: Turn[] = (parsed.turns ?? []).map((t: any, i: number) => ({ turn: Number(t.turn ?? from + i), user: String(t.user ?? ""), steps: Array.isArray(t.steps) ? t.steps : [], reply: String(t.reply ?? "") }))
      const factTexts: FactText[] = parsed.facts ?? []
      const errors = checkChunk(chunkTurns, facts, from, to, forbidden)
      for (const f of questions) {
        const text = factTexts.find((x) => x.id === f.id)
        if (!text?.question) errors.push(`missing question for ${f.id}`)
        const leaks = [f.answer, ...(f.stale ? [f.stale] : [])].filter((a) => text && `${text.question} ${text.task ?? ""}`.includes(a))
        if (leaks.length) errors.push(`the question or task for ${f.id} reveals a value (${leaks.join(", ")})`)
        if (f.implicit && !text?.task) errors.push(`missing task for ${f.id}`)
      }
      if (errors.length) {
        feedback = errors.map((e) => `- ${e}`).join("\n")
        log(`turns ${from}-${to}: attempt ${attempt + 1} rejected (${errors.length}: ${errors[0].slice(0, 90)})`)
        continue
      }
      accepted = { turns: chunkTurns.sort((a, b) => a.turn - b.turn), facts: factTexts }
    }
    if (!accepted) { log(`turns ${from}-${to}: gave up`); return null }
    progress.turns.push(...accepted.turns)
    for (const f of accepted.facts) progress.facts[f.id] = f
    writeFileSync(progressFile, JSON.stringify(progress))
    log(`turns ${from}-${to} ok`)
  }

  // Whole-session check: every value lives exactly where the plan put it.
  const errors = checkChunk(progress.turns, facts, 1, turns, [])
  if (errors.length) { log(`whole-session check failed: ${errors.slice(0, 3).join("; ")}`); return null }

  const sessionId = crypto.randomUUID()
  const { lines, tokens } = toSessionLines(progress.turns, { sessionId, cwd: repo.root, model: GENERATOR_MODEL, start: Date.parse("2026-09-01T09:00:00Z") + index * 86_400_000 })
  writeFileSync(path.join(SESSIONS, `${id}.jsonl`), lines.join("\n") + "\n")
  writeFileSync(path.join(SESSIONS, `${id}.turns.json`), JSON.stringify(progress.turns, null, 1))
  const meta: Meta = {
    id, index, split: index % 3 === 0 ? "dev" : "test", repo: repo.name, cwd: repo.root, title: progress.title, style, turns, tokens,
    facts: facts.map((f) => ({ ...f, question: progress.facts[f.id]?.question ?? "", task: progress.facts[f.id]?.task, ago: agoOf(f, turns) })),
  }
  writeFileSync(metaFile, JSON.stringify(meta, null, 2))
  log(`done: ${turns} turns, ~${Math.round(tokens / 1000)}k tokens`)
  return meta
}

if (import.meta.main) {
  mkdirSync(SESSIONS, { recursive: true })
  const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number)
  const count = nums[0] ?? 36
  const parallel = nums[1] ?? 6
  const only = process.argv.slice(2).find((a) => a.startsWith("--only="))?.slice(7).split(",").map(Number)
  const queue = only ?? Array.from({ length: count }, (_, i) => i)
  let next = 0
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (next < queue.length) {
      const i = queue[next++]
      const tag = `s${String(i).padStart(2, "0")}`
      await generateSession(i, (m) => console.log(`[${tag}] ${m}`)).catch((e) => console.error(`[${tag}]`, e))
    }
  }))
  console.log("done")
}
