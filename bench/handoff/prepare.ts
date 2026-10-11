import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { blocks, describeToolCall, resultText } from "../../src/context/content"
import { foldedView } from "../../src/context/fold"
import { FOLD_CAP_CHARS } from "../../src/context/fold/constants"
import { isPrompt, splitTurns } from "../../src/context/fold/turns"
import { sessionMessages } from "../../src/transcript/messages"
import { claude } from "../lib/claude"
import { NO_TOOLS } from "../lib/constants"
import { extractJson } from "../lib/json"
import { SESSIONS } from "../planted/constants"
import type { Meta } from "../planted/generate"
import { loadMetas } from "../planted/run"
import type { Scenario } from "./arms"
import { BRIEF, BRIEF_MODELS, HANDOFF_OUT, INJECT, PROMPTS, RULES, RULES_MODEL, SCENARIOS } from "./constants"

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const norm = (t: string) => t.toLowerCase().replace(/[`'"]/g, "")

export const sessionFile = (meta: Meta) => path.join(SESSIONS, `${meta.id}.jsonl`)

function textOf(message: any): string {
  return blocks(message)
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim()
}

export function outline(meta: Meta): string {
  const { turns } = splitTurns(sessionMessages(sessionFile(meta)))
  return turns
    .filter((t) => isPrompt(t[0]))
    .map((t, i) => `${i + 1}. ${textOf(t[0]).slice(0, 240)}`)
    .join("\n")
}

export function fullTranscript(meta: Meta): string {
  const { turns } = splitTurns(sessionMessages(sessionFile(meta)))
  return turns
    .filter((t) => isPrompt(t[0]))
    .map((turn, i) => {
      const parts = [`### Turn ${i + 1}`, `**You:** ${textOf(turn[0])}`]
      for (const m of turn.slice(1)) {
        for (const b of blocks(m)) {
          if (b.type === "text" && m.role === "assistant" && String(b.text ?? "").trim()) parts.push(`**Agent:** ${String(b.text).trim()}`)
          if (b.type === "tool_use") parts.push(`[tool] ${describeToolCall(b)}`)
          if (b.type === "tool_result") parts.push(`\`\`\`\n${resultText(b).slice(0, 20_000)}\n\`\`\``)
        }
      }
      return parts.join("\n\n")
    })
    .join("\n\n")
}

const plantedValues = (meta: Meta) => [
  ...new Set(
    meta.facts
      .flatMap((f) => [f.answer, f.stale])
      .filter(Boolean)
      .map(String),
  ),
]
const leaks = (text: string, meta: Meta) => plantedValues(meta).filter((v) => norm(text).includes(norm(v)))

const RESUME = (meta: Meta, scenario: Scenario) => `A developer is opening a brand-new Claude Code session on the project below, days after an earlier session, and types the first message. Write that first message.

Session title: ${meta.title}
The developer writes like this: ${meta.style}
What happened in the earlier session, turn by turn (the developer's messages):
${outline(meta)}

Scenario "${scenario}":
${scenario === "bug" ? "They are coming back to fix one specific bug in something that earlier session built. Pick a plausible, concrete problem in that work and describe it the way a person who half-remembers the session would: the symptom, roughly where it is, nothing more." : ""}${scenario === "continue" ? "They want to pick the work up where it was left and keep going. Say what they want to continue with, in their own words, without a precise checklist." : ""}${scenario === "rules" ? "They are starting a new small piece of work in the same area and expect the agent to work the way they taught it last time. Describe the new task; do not restate any rules." : ""}

Hard rules: one to three sentences, in the developer's voice. Never quote exact identifiers, hashes, IDs, URLs, flags, prefixes or numbers from the session; refer to things by what they are, not by their values. Do not mention that an earlier session exists or ask the agent to read a transcript.

Reply with only the message text.`

async function model(name: string, prompt: string, maxOut = "16000") {
  const out = await claude(["--model", name, ...NO_TOOLS], { cwd: HANDOFF_OUT, stdin: prompt, env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: maxOut } })
  if (out.is_error || !String(out.result ?? "").trim()) throw new Error(`${name}: ${String(out.result ?? "no result").slice(0, 200)}`)
  return String(out.result ?? "")
}

async function cached(file: string, make: () => Promise<string>) {
  if (existsSync(file)) return readFileSync(file, "utf8")
  const text = await make()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
  return text
}

const NEW_WORK = (
  meta: Meta,
  siblings: Meta[],
) => `A developer opens a brand-new Claude Code session in the repository below and types the first message: a request for a small piece of NEW work that has nothing to do with any of the earlier sessions listed. It must not fix, continue or extend anything those sessions touched, and must not follow on from them.

Repository: ${meta.repo}
The developer writes like this: ${meta.style}
Earlier sessions in this repository, with the developer's messages:
${siblings.map((m) => `## ${m.title}\n${outline(m).slice(0, 4000)}`).join("\n\n")}

One to three sentences, in the developer's voice, concrete enough to act on. Reply with only the message text.`

export async function newWorkPrompt(meta: Meta): Promise<string> {
  const siblings = loadMetas("all").filter((m) => m.repo === meta.repo)
  return (await cached(path.join(PROMPTS, `${meta.id}.new.txt`), () => model(RULES_MODEL, NEW_WORK(meta, siblings), "2000"))).trim().replace(/^"|"$/g, "")
}

export function multiFolded(sources: Meta[], cap: number): string {
  const share = Math.floor(cap / Math.max(1, sources.length))
  return sources.map((m) => `## Session: ${m.title}\n\n${foldedView(sessionMessages(sessionFile(m)), share)}`).join("\n\n")
}

export async function prepareSession(meta: Meta, log: (m: string) => void) {
  const messages = sessionMessages(sessionFile(meta))
  const folded = await cached(path.join(INJECT, `${meta.id}.folded.md`), async () => foldedView(messages))
  await cached(path.join(INJECT, `${meta.id}.folded-capped.md`), async () => foldedView(messages, FOLD_CAP_CHARS))
  await cached(path.join(INJECT, `${meta.id}.folded-cap60.md`), async () => foldedView(messages, 60_000))
  await cached(path.join(INJECT, `${meta.id}.folded-cap40.md`), async () => foldedView(messages, 40_000))
  await cached(path.join(INJECT, `${meta.id}.full.md`), async () => fullTranscript(meta))
  const promptFile = path.join(PROMPTS, `${meta.id}.json`)
  if (!existsSync(promptFile)) {
    const prompts: Record<string, string> = {}
    for (const scenario of SCENARIOS) {
      let text = ""
      for (let attempt = 0; attempt < 3; attempt += 1) {
        text = (await model(RULES_MODEL, RESUME(meta, scenario), "2000")).trim().replace(/^"|"$/g, "")
        const leaked = leaks(text, meta)
        if (leaked.length === 0) break
        log(`${scenario} prompt leaked ${leaked.join(", ")}; retrying`)
      }
      prompts[scenario] = text
    }
    mkdirSync(PROMPTS, { recursive: true })
    writeFileSync(promptFile, JSON.stringify(prompts, null, 2))
    log(`prompts: ${SCENARIOS.map((s) => `${s} ${prompts[s].length}c`).join(", ")}`)
  }
  await cached(path.join(INJECT, `${meta.id}.rules.md`), async () => {
    const out = await model(RULES_MODEL, RULES(folded))
    let rules: string[] = []
    try {
      rules = extractJson(out).rules.map(String)
    } catch {
      rules = [out]
    }
    const replies = foldedView(messages)
      .split(/\n(?=### Turn )/)
      .slice(-3)
      .map((t) => t.match(/\*\*Agent:\*\* ([\s\S]*)$/)?.[1]?.trim())
      .filter(Boolean)
    return `## Rules from the earlier session\n${rules.map((r) => `- ${r}`).join("\n")}\n\n## Where the earlier session ended\n${replies.map((r) => `- ${r}`).join("\n")}`
  })
  for (const [size, name] of Object.entries(BRIEF_MODELS)) {
    await cached(path.join(INJECT, `${meta.id}.brief-${size}.md`), () => model(name, BRIEF(folded)))
  }
  log("prepared")
}

if (import.meta.main) {
  const metas = loadMetas(arg("split") ?? "dev", arg("sessions")?.split(","))
  const parallel = Number(arg("parallel") ?? 4)
  console.log(`preparing ${metas.length} sessions`)
  let next = 0
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < metas.length) {
        const meta = metas[next++]
        await prepareSession(meta, (m) => console.log(`[${meta.id} ${meta.repo}] ${m}`)).catch((e) => console.error(`[${meta.id}]`, e))
      }
    }),
  )
  console.log("done")
}
