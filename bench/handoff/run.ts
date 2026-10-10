import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { extractJson } from "../lib/json"
import { AccountLimited, chooseAccount, claude, projectDir } from "../lib/claude"
import { ALL_CONFIG_DIRS, BASE_SETTINGS, READ_ONLY } from "../lib/constants"
import { findSessionFile } from "../../src/transcript/locate"
import { startProxies as spawnProxies } from "../lib/proxy"
import { lookupsAfterQuestion } from "../real/run"
import { type Meta } from "../planted/generate"
import { ANSWER_MODEL, CANON, RECALL, TASKS } from "../planted/constants"
import { loadMetas, verdict, type ArmResult } from "../planted/run"
import { handoffArm, proxyOf, type HandoffArm, type Scenario } from "./arms"
import { multiFolded, newWorkPrompt, outline, prepareSession, sessionFile } from "./prepare"
import { rank, terms } from "../../src/context/recall"
import { AGENT_BIN, AGENT_CANON, AGENT_SECTIONS, HANDOFF_ARMS, INJECT, PROMPTS, PROXIES, RUNS, SCENARIOS } from "./constants"

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
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } })
    .filter((r) => String(r.thread ?? "").startsWith(session) || r.context?.session === session)
}

async function runOne(meta: Meta, scenario: Scenario, arm: HandoffArm, log: (m: string) => void): Promise<HandoffResult> {
  const spec = proxyOf(arm)
  const prompts = JSON.parse(readFileSync(path.join(PROMPTS, `${meta.id}.json`), "utf8"))
  const asked = scenario === "new" ? await newWorkPrompt(meta) : (prompts[scenario] as string)
  const resume = arm.agent === "manual" ? `${asked}\n\nThis continues an earlier session: run \`eunoe load ${meta.id}\`` : asked
  const siblings = loadMetas("all").filter((m) => m.repo === meta.repo)
  const picked = arm.pick ? pickSource(resume, siblings) : meta
  if (arm.pick && arm.inject !== "multi" && !existsSync(path.join(INJECT, `${picked.id}.${arm.inject}.md`))) await prepareSession(picked, log)
  const source = arm.allSources ? siblings.map(sessionFile).join(",") : sessionFile(meta)
  let injectFile = arm.inject ? path.join(INJECT, `${picked.id}.${arm.inject}.md`) : null
  if (arm.inject === "multi") {
    const chosen = rankSources(resume, siblings).slice(0, arm.multi ?? 2)
    injectFile = path.join(INJECT, `${meta.id}.${scenario}.multi${arm.multi ?? 2}.md`)
    if (!existsSync(injectFile)) writeFileSync(injectFile, multiFolded(chosen, 120_000))
  }
  const headers = [`x-eunoe-canonical: ${arm.agent ? agentCanon(meta, arm.section ?? "v1") : path.join(CANON, `${meta.id}.json`)}`]
  if (injectFile) headers.push(`x-eunoe-handoff-file: ${injectFile}`)
  if (arm.recall) headers.push(`x-eunoe-handoff-source: ${source}`)
  if (arm.users) headers.push(`x-eunoe-handoff-source-users: 1`)
  if (arm.hint) headers.push(`x-eunoe-transcript: ${source}`)
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${spec.port}`, ANTHROPIC_CUSTOM_HEADERS: headers.join("\n") }
  if (arm.agent) Object.assign(env, { PATH: `${AGENT_BIN}:${process.env.PATH}`, EUNOE_BENCH_SESSIONS: siblings.map((m) => m.id).join(","), EUNOE_BENCH_LOAD: arm.load ?? "pages" })
  const settings = JSON.stringify({ ...BASE_SETTINGS, autoCompactEnabled: false, env })
  const started = Date.now()
  const id = crypto.randomUUID()
  const account = chooseAccount()
  const common = ["--model", ANSWER_MODEL, "--permission-mode", "default", "--settings", settings, "--allowedTools", arm.agent ? `${READ_ONLY} Bash(eunoe:*)` : READ_ONLY]
  const errors: string[] = []
  const opening = await claude(["--session-id", id, ...common], { cwd: meta.cwd, stdin: resume, env, account })
  const openingMs = Date.now() - started
  if (scenario === "new") {
    const file = findSessionFile(id, ALL_CONFIG_DIRS) ?? path.join(projectDir(meta.cwd), `${id}.jsonl`)
    const calls = agentCalls(file)
    rmSync(file, { force: true })
    log(`new/${arm.name}: ${calls.length} session commands, ${Math.round(openingMs / 1000)}s`)
    const none = { lookups: { calls: 0 } as any, requests: 0, contextAtTasks: null, contextAtRecall: null, tokensProcessed: 0, cacheRead: 0, cacheWrite: 0 }
    return { arm: arm.name, scenario, resumePrompt: asked, opening: String(opening.result ?? "").slice(0, 2000), openingMs, injectedChars: 0, replies: {}, answers: {}, tasks: {}, recall: {}, ...none, wallMs: openingMs, notes: [], errors: [], agentCalls: calls }
  }
  const implicit = meta.facts.filter((f) => f.implicit && f.task)
  const first = await claude(["--resume", id, ...common], { cwd: meta.cwd, stdin: TASKS(implicit), env, account })
  let replies: Record<string, string> = {}
  try { replies = Object.fromEntries(extractJson(first.result).replies.map((r: any) => [String(r.id), String(r.reply ?? "")])) } catch { errors.push(`tasks: ${String(first.result).slice(0, 200)}`) }
  const recallStart = new Date().toISOString()
  const second = await claude(["--resume", id, ...common], { cwd: meta.cwd, stdin: RECALL(meta.facts), env, account })
  const file = findSessionFile(id, ALL_CONFIG_DIRS) ?? path.join(projectDir(meta.cwd), `${id}.jsonl`)
  let answers: Record<string, string> = {}
  try { answers = Object.fromEntries(extractJson(second.result).answers.map((a: any) => [String(a.id), String(a.answer ?? "")])) } catch { errors.push(`recall: ${String(second.result).slice(0, 200)}`) }
  const lookups = lookupsAfterQuestion(file, meta.cwd)
  const calls = arm.agent ? agentCalls(file) : undefined
  rmSync(file, { force: true })
  const requests = requestsOf(spec.proxy, id)
  const inputs = requests.filter((r) => r.input)
  log(`${scenario}/${arm.name}${arm.pick ? ` (picked ${picked.id}${picked.id === meta.id ? "" : ", wrong"})` : ""}${account === "3" ? "" : ` [acct ${account}]`}: ${Object.keys(answers).length} answers, ${Object.keys(replies).length} replies, ${lookups.calls} lookups, ${Math.round((Date.now() - started) / 1000)}s`)
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
  if (!existsSync(path.join(CANON, `${meta.id}.json`))) { log("no canonical prompt from the planted suite; skipping"); return }
  await prepareSession(meta, log)
  const dir = path.join(RUNS, tag)
  mkdirSync(dir, { recursive: true })
  for (const scenario of scenarios) {
    const todo = arms.filter((a) => !existsSync(path.join(dir, `${meta.id}.${scenario}.${a.name}.json`)))
    await Promise.all(todo.map(async (arm) => {
      let result: HandoffResult
      for (;;) {
        try { result = await runOne(meta, scenario, arm, log); break } catch (e) {
          if (!(e instanceof AccountLimited)) throw e
          log(`${scenario}/${arm.name}: ${e.message}; restarting on account ${chooseAccount()}`)
        }
      }
      writeFileSync(path.join(dir, `${meta.id}.${scenario}.${arm.name}.json`), JSON.stringify(result, null, 2))
    }))
  }
}

if (import.meta.main) {
  const split = arg("split") ?? "dev"
  const arms = (arg("arms") ?? HANDOFF_ARMS.map((a) => a.name).join(",")).split(",").map(handoffArm)
  const scenarios = ((arg("scenarios") ?? SCENARIOS.join(",")).split(",")) as Scenario[]
  const metas = loadMetas(split, arg("sessions")?.split(","))
  const parallel = Number(arg("parallel") ?? 2)
  const tag = arg("tag") ?? "main"
  console.log(`${metas.length} ${split} sessions × ${scenarios.length} scenarios × ${arms.length} arms (${arms.map((a) => a.name).join(", ")}) → handoff/runs/${tag}`)
  const proxies = spawnProxies(PROXIES, path.join(RUNS, "proxies"))
  await Bun.sleep(1500)
  try {
    let next = 0
    await Promise.all(Array.from({ length: parallel }, async () => {
      while (next < metas.length) {
        const meta = metas[next++]
        await runSession(meta, arms, scenarios, tag).catch((e) => console.error(`[${meta.id}]`, e))
      }
    }))
  } finally {
    proxies.forEach((p) => p.kill())
  }
  console.log("done")
}
