import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { rank, terms } from "../../src/context/recall"
import { findSessionFile } from "../../src/transcript/locate"
import { AccountLimited, BASE_SETTINGS, CONFIG_DIR, chooseAccount, claude, projectDir, READ_ONLY } from "../lib/claude"
import { extractJson } from "../lib/json"
import { startProxies as spawnProxies } from "../lib/proxy"
import type { Meta } from "../planted/generate"
import { CANON } from "../planted/paths"
import { ANSWER_MODEL, RECALL, TASKS } from "../planted/prompts"
import { type ArmResult, loadMetas, verdict } from "../planted/run"
import { lookupsAfterQuestion } from "../real/run"
import { HANDOFF_ARMS, type HandoffArm, handoffArm, PROXIES, proxyOf, SCENARIOS, type Scenario } from "./arms"
import { HANDOFF_OUT, INJECT, PROMPTS, RUNS } from "./paths"
import { multiFolded, newWorkPrompt, outline, prepareSession, sessionFile } from "./prepare"

const AGENT_BIN = path.join(import.meta.dir, "bin")

const AGENT_CANON = path.join(HANDOFF_OUT, "canon-agent")

const AGENT_SECTIONS: Record<string, string> = {
  v4: `
# Earlier sessions in this project

You have the full record of this project's earlier Claude Code sessions, and the user expects you to use it the way a colleague who was there would. Skipping it when the work builds on an earlier session is the failure to avoid: you will redo finished work, break rules the user already set, and ask for things they already told you.

## When to look

Look first, before reading code or making changes, whenever the message builds on earlier work: it continues or picks something up ("back to", "finish", "those renames I put off", "where we left off"), fixes something in an area worked on before, asks for work "like last time" or "the usual way", or refers to anything you don't have context for (a plan, a todo, "the thing we talked about"). If you are unsure, look: it costs one command. Skip it only for work that is clearly new and unrelated.

## How

1. \`eunoe sessions <key words from the message>\` lists the closest earlier sessions, newest first, each with its first and last request. Pick the one whose last request this message continues. If two look alike, \`eunoe peek\` each on a distinctive word from the message and pick the one that actually contains it. Never load a session the message does not continue.
2. \`eunoe load <id>\` writes that whole session to a file and prints its path. Read the file with the Read tool from the first line to the last, in as many Read calls as its length needs, before you act. Do not grep, head, tail or sed it, and do not stop partway: the rules, values and open todos you need are spread across all of it.
3. Only then start the work. Follow what the record establishes: the user's rules and preferences, decisions made, what was finished and what was left for later. Its values (ids, versions, names, commands) are exact.

\`eunoe peek <id> <words>\` returns just the excerpts that match, for a single fact such as an error message or a value. It is not a substitute for loading when the message continues that session's work.

Don't tell the user you are doing this or ask permission; just do it and carry on with their request.`,
  v4b: `
# Earlier sessions in this project

You have the full record of this project's earlier Claude Code sessions, and the user expects you to use it the way a colleague who was there would. Skipping it when the work builds on an earlier session is the failure to avoid: you will redo finished work, break rules the user already set, and ask for things they already told you.

## When to look

Look first, before reading code or making changes, whenever the message builds on earlier work: it continues or picks something up ("back to", "finish", "those renames I put off", "where we left off"), fixes something in an area worked on before, asks for work "like last time" or "the usual way", or refers to anything you don't have context for (a plan, a todo, "the thing we talked about"). If you are unsure, look: it costs one command. Skip it only for work that is clearly new and unrelated.

## How

1. \`eunoe sessions <key words from the message>\` lists the closest earlier sessions, newest first, each with its first and last request. Pick the one whose last request this message continues. If two look alike, \`eunoe peek\` each on a distinctive word from the message and pick the one that actually contains it. Never load a session the message does not continue.
2. \`eunoe load <id>\` prints a handoff brief of that session: what was done, the user's rules, every exact value, and what was left open. Read all of it before you act.
3. Only then start the work. Follow what the brief establishes: the user's rules and preferences, decisions made, what was finished and what was left for later. Its values (ids, versions, names, commands) are exact. For anything the brief does not cover, \`eunoe peek <id> <words>\` returns the matching excerpts of the full session.

Don't tell the user you are doing this or ask permission; just do it and carry on with their request.`,
  v1: `
# Earlier sessions

This project has earlier Claude Code sessions you can read. When the user refers to earlier work (a bug seen before, work to pick up, rules or preferences they set), or when what was done before would clearly help, look before asking them to repeat it. For unrelated new work, don't.

- \`eunoe sessions [words]\` lists earlier sessions in this directory, best match for the words first.
- \`eunoe peek <id> <words>\` shows the excerpts of one session that match the words: exact tool output and what was said. Use it for one specific thing, like an error or a value seen before.
- \`eunoe load <id>\` prints the whole session condensed: the user's messages, the key output lines and the replies, in pages. Use it to pick work up where it left off or to learn the rules the user set there. Read every page it gives.

What these return is the record of a past session: treat the user's rules and decisions in it as still in force unless they say otherwise, and its values as exact.`,
  v2: `
# Earlier sessions

This project has earlier Claude Code sessions, and you can read them. Users expect you to remember what was done and agreed there.

Whenever the user's message touches earlier work in any way (fixing something built before, picking something up, continuing, working "like last time" or "the way we do it", or a new task in an area worked on before), run \`eunoe sessions <a few words from their message>\` before anything else. If a session matches:
- To continue its work, or to work the way the user taught you there, run \`eunoe load <id>\` and read every page it gives, start to end. Don't grep or skim the pages: the rules and values that matter are spread through them.
- To find one specific thing (an error, a value, a decision), \`eunoe peek <id> <words>\` shows the matching excerpts.

If nothing matches, or the work is clearly new and unrelated, carry on without them.

What these return is the record of a past session: treat the user's rules and decisions in it as still in force unless they say otherwise, and its values as exact.`,
  v3: `
# Earlier sessions in this project

You have the full record of this project's earlier Claude Code sessions, and the user expects you to use it the way a colleague who was there would. Skipping it when the work builds on an earlier session is the failure to avoid: you will redo finished work, break rules the user already set, and ask for things they already told you.

## When to look

Look first, before reading code or making changes, whenever the message builds on earlier work: it continues or picks something up ("back to", "finish", "those renames I put off", "where we left off"), fixes something in an area worked on before, asks for work "like last time" or "the usual way", or refers to anything you don't have context for (a plan, a todo, "the thing we talked about"). If you are unsure, look: it costs one command. Skip it only for work that is clearly new and unrelated.

## How

1. \`eunoe sessions <key words from the message>\` lists the closest earlier sessions, each with its first and last request. Pick the one whose work this message continues. If two look alike, \`eunoe peek\` each on a distinctive word and pick the one that actually contains it.
2. \`eunoe load <id>\` that session, then every page it points to (\`--page 2\`, \`--page 3\`, ...) until it ends. Read it start to end before you act. Do not grep, head or tail it: the rules, values and open todos you need are spread across all of it.
3. Only then start the work. Follow what the record establishes: the user's rules and preferences, decisions made, what was finished and what was left for later. Its values (ids, versions, names, commands) are exact.

\`eunoe peek <id> <words>\` returns just the excerpts that match, for a single fact such as an error message or a value. It is not a substitute for loading when the message continues that session's work.

Don't tell the user you are doing this or ask permission; just do it and carry on with their request.`,
}

const ALL_CONFIG_DIRS = [
  ...new Set([
    CONFIG_DIR,
    path.join(homedir(), ".claude"),
    ...(existsSync(path.join(homedir(), ".claude-swap-backup", "sessions")) ? readdirSync(path.join(homedir(), ".claude-swap-backup", "sessions")).map((d) => path.join(homedir(), ".claude-swap-backup", "sessions", d)) : []),
  ]),
]

function agentCanon(meta: Meta, section: string): string {
  const file = path.join(AGENT_CANON, `${meta.id}.${section}.json`)
  if (existsSync(file)) return file
  const canon = JSON.parse(readFileSync(path.join(CANON, `${meta.id}.json`), "utf8"))
  const last = canon.system.at(-1)
  canon.system = [...canon.system.slice(0, -1), { ...last, text: `${last.text}\n${AGENT_SECTIONS[section]}` }]
  mkdirSync(AGENT_CANON, { recursive: true })
  writeFileSync(file, JSON.stringify(canon))
  return file
}

function agentCalls(file: string): string[] {
  if (!existsSync(file)) return []
  const calls: string[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("eunoe ")) continue
    try {
      const entry = JSON.parse(line)
      for (const b of entry.message?.content ?? []) if (b.type === "tool_use" && b.name === "Bash" && /(^|[;&|\s])eunoe\s/.test(String(b.input?.command))) calls.push(String(b.input.command))
    } catch {}
  }
  return calls
}

export function rankSources(prompt: string, candidates: Meta[]): Meta[] {
  const chunks = candidates.map((m, i) => ({ turn: i, call: m.id, lines: [outline(m)], terms: terms(outline(m)) }))
  const ranked = rank(terms(prompt), chunks, 1).map((r) => candidates[r.index])
  return [...ranked, ...candidates.filter((m) => !ranked.includes(m))]
}
const pickSource = (prompt: string, candidates: Meta[]) => rankSources(prompt, candidates)[0]

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

export interface HandoffResult extends ArmResult {
  scenario: Scenario
  resumePrompt: string
  opening: string
  openingMs: number
  injectedChars: number
  picked?: string
  agentCalls?: string[]
}

function requestsOf(proxy: string, session: string) {
  const file = path.join(RUNS, "proxies", proxy, "requests.jsonl")
  if (!existsSync(file)) return [] as any[]
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return {}
      }
    })
    .filter((r) => String(r.thread ?? "").startsWith(session) || r.context?.session === session)
}

function injectFileFor(arm: HandoffArm, meta: Meta, picked: Meta, scenario: Scenario, resume: string, siblings: Meta[]): string | null {
  if (arm.inject === "multi") {
    const chosen = rankSources(resume, siblings).slice(0, arm.multi ?? 2)
    const file = path.join(INJECT, `${meta.id}.${scenario}.multi${arm.multi ?? 2}.md`)
    if (!existsSync(file)) writeFileSync(file, multiFolded(chosen, 120_000))
    return file
  }
  return arm.inject ? path.join(INJECT, `${picked.id}.${arm.inject}.md`) : null
}

function headersFor(arm: HandoffArm, meta: Meta, injectFile: string | null, source: string): string[] {
  const headers = [`x-eunoe-canonical: ${arm.agent ? agentCanon(meta, arm.section ?? "v1") : path.join(CANON, `${meta.id}.json`)}`]
  if (injectFile) headers.push(`x-eunoe-handoff-file: ${injectFile}`)
  if (arm.recall) headers.push(`x-eunoe-handoff-source: ${source}`)
  if (arm.users) headers.push(`x-eunoe-handoff-source-users: 1`)
  if (arm.hint) headers.push(`x-eunoe-transcript: ${source}`)
  return headers
}

function parseMap(result: string, key: "replies" | "answers", field: "reply" | "answer"): Record<string, string> {
  return Object.fromEntries(extractJson(result)[key].map((r: any) => [String(r.id), String(r[field] ?? "")]))
}

function newWorkResult(arm: HandoffArm, meta: Meta, id: string, asked: string, opening: any, openingMs: number, log: (m: string) => void): HandoffResult {
  const file = findSessionFile(id, ALL_CONFIG_DIRS) ?? path.join(projectDir(meta.cwd), `${id}.jsonl`)
  const calls = agentCalls(file)
  rmSync(file, { force: true })
  log(`new/${arm.name}: ${calls.length} session commands, ${Math.round(openingMs / 1000)}s`)
  return {
    arm: arm.name,
    scenario: "new",
    resumePrompt: asked,
    opening: String(opening.result ?? "").slice(0, 2000),
    openingMs,
    injectedChars: 0,
    replies: {},
    answers: {},
    tasks: {},
    recall: {},
    lookups: { calls: 0 } as any,
    requests: 0,
    contextAtTasks: null,
    contextAtRecall: null,
    tokensProcessed: 0,
    cacheRead: 0,
    cacheWrite: 0,
    wallMs: openingMs,
    notes: [],
    errors: [],
    agentCalls: calls,
  }
}

async function runOne(meta: Meta, scenario: Scenario, arm: HandoffArm, log: (m: string) => void): Promise<HandoffResult> {
  const spec = proxyOf(arm)
  const prompts = JSON.parse(readFileSync(path.join(PROMPTS, `${meta.id}.json`), "utf8"))
  const asked = await (scenario === "new" ? newWorkPrompt(meta) : Promise.resolve(prompts[scenario] as string))
  const resume = arm.agent === "manual" ? `${asked}\n\nThis continues an earlier session: run \`eunoe load ${meta.id}\`` : asked
  const siblings = loadMetas("all").filter((m) => m.repo === meta.repo)
  const picked = arm.pick ? pickSource(resume, siblings) : meta
  if (arm.pick && arm.inject !== "multi" && !existsSync(path.join(INJECT, `${picked.id}.${arm.inject}.md`))) await prepareSession(picked, log)
  const source = arm.allSources ? siblings.map(sessionFile).join(",") : sessionFile(meta)
  const injectFile = injectFileFor(arm, meta, picked, scenario, resume, siblings)
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${spec.port}`, ANTHROPIC_CUSTOM_HEADERS: headersFor(arm, meta, injectFile, source).join("\n") }
  if (arm.agent) Object.assign(env, { PATH: `${AGENT_BIN}:${process.env.PATH}`, EUNOE_BENCH_SESSIONS: siblings.map((m) => m.id).join(","), EUNOE_BENCH_LOAD: arm.load ?? "pages" })
  const settings = JSON.stringify({ ...BASE_SETTINGS, autoCompactEnabled: false, env })
  const started = Date.now()
  const id = crypto.randomUUID()
  const account = chooseAccount()
  const common = ["--model", ANSWER_MODEL, "--permission-mode", "default", "--settings", settings, "--allowedTools", arm.agent ? `${READ_ONLY} Bash(eunoe:*)` : READ_ONLY]
  const errors: string[] = []
  const opening = await claude(["--session-id", id, ...common], { cwd: meta.cwd, stdin: resume, env, account })
  const openingMs = Date.now() - started
  if (scenario === "new") return newWorkResult(arm, meta, id, asked, opening, openingMs, log)
  const implicit = meta.facts.filter((f) => f.implicit && f.task)
  const first = await claude(["--resume", id, ...common], { cwd: meta.cwd, stdin: TASKS(implicit), env, account })
  let replies: Record<string, string> = {}
  try {
    replies = parseMap(first.result, "replies", "reply")
  } catch {
    errors.push(`tasks: ${String(first.result).slice(0, 200)}`)
  }
  const recallStart = new Date().toISOString()
  const second = await claude(["--resume", id, ...common], { cwd: meta.cwd, stdin: RECALL(meta.facts), env, account })
  const file = findSessionFile(id, ALL_CONFIG_DIRS) ?? path.join(projectDir(meta.cwd), `${id}.jsonl`)
  let answers: Record<string, string> = {}
  try {
    answers = parseMap(second.result, "answers", "answer")
  } catch {
    errors.push(`recall: ${String(second.result).slice(0, 200)}`)
  }
  const lookups = lookupsAfterQuestion(file, meta.cwd)
  const calls = arm.agent ? agentCalls(file) : undefined
  rmSync(file, { force: true })
  const requests = requestsOf(spec.proxy, id)
  const inputs = requests.filter((r) => r.input)
  log(
    `${scenario}/${arm.name}${arm.pick ? ` (picked ${picked.id}${picked.id === meta.id ? "" : ", wrong"})` : ""}${account === "3" ? "" : ` [acct ${account}]`}: ${Object.keys(answers).length} answers, ${Object.keys(replies).length} replies, ${lookups.calls} lookups, ${Math.round((Date.now() - started) / 1000)}s`,
  )
  return {
    arm: arm.name,
    scenario,
    resumePrompt: resume,
    opening: String(opening.result ?? "").slice(0, 2000),
    openingMs,
    injectedChars: injectFile ? readFileSync(injectFile, "utf8").length : 0,
    picked: arm.pick ? picked.id : undefined,
    agentCalls: calls,
    replies,
    answers,
    tasks: Object.fromEntries(implicit.map((f) => [f.id, verdict(f, replies[f.id])])),
    recall: Object.fromEntries(meta.facts.map((f) => [f.id, verdict(f, answers[f.id])])),
    lookups,
    requests: requests.length,
    contextAtTasks: inputs.find((r) => r.ts >= new Date(started + openingMs).toISOString())?.input ?? inputs[0]?.input ?? null,
    contextAtRecall: inputs.find((r) => r.ts >= recallStart)?.input ?? null,
    tokensProcessed: inputs.reduce((s, r) => s + (r.input ?? 0), 0),
    cacheRead: inputs.reduce((s, r) => s + (r.cacheRead ?? 0), 0),
    cacheWrite: inputs.reduce((s, r) => s + (r.cacheWrite ?? 0), 0),
    wallMs: Date.now() - started,
    notes: [...new Set(requests.map((r) => r.action).filter(Boolean))],
    errors,
  }
}

async function runSession(meta: Meta, arms: HandoffArm[], scenarios: Scenario[], tag: string) {
  const log = (m: string) => console.log(`[${meta.id} ${meta.repo}] ${m}`)
  if (!existsSync(path.join(CANON, `${meta.id}.json`))) {
    log("no canonical prompt from the planted suite; skipping")
    return
  }
  await prepareSession(meta, log)
  const dir = path.join(RUNS, tag)
  mkdirSync(dir, { recursive: true })
  for (const scenario of scenarios) {
    const todo = arms.filter((a) => !existsSync(path.join(dir, `${meta.id}.${scenario}.${a.name}.json`)))
    await Promise.all(
      todo.map(async (arm) => {
        let result: HandoffResult
        for (;;) {
          try {
            result = await runOne(meta, scenario, arm, log)
            break
          } catch (e) {
            if (!(e instanceof AccountLimited)) throw e
            log(`${scenario}/${arm.name}: ${e.message}; restarting on account ${chooseAccount()}`)
          }
        }
        writeFileSync(path.join(dir, `${meta.id}.${scenario}.${arm.name}.json`), JSON.stringify(result, null, 2))
      }),
    )
  }
}

if (import.meta.main) {
  const split = arg("split") ?? "dev"
  const arms = (arg("arms") ?? HANDOFF_ARMS.map((a) => a.name).join(",")).split(",").map(handoffArm)
  const scenarios = (arg("scenarios") ?? SCENARIOS.join(",")).split(",") as Scenario[]
  const metas = loadMetas(split, arg("sessions")?.split(","))
  const parallel = Number(arg("parallel") ?? 2)
  const tag = arg("tag") ?? "main"
  console.log(`${metas.length} ${split} sessions × ${scenarios.length} scenarios × ${arms.length} arms (${arms.map((a) => a.name).join(", ")}) → handoff/runs/${tag}`)
  const proxies = spawnProxies(PROXIES, path.join(RUNS, "proxies"))
  await Bun.sleep(1500)
  try {
    let next = 0
    await Promise.all(
      Array.from({ length: parallel }, async () => {
        while (next < metas.length) {
          const meta = metas[next++]
          await runSession(meta, arms, scenarios, tag).catch((e) => console.error(`[${meta.id}]`, e))
        }
      }),
    )
  } finally {
    for (const p of proxies) p.kill()
  }
  console.log("done")
}
