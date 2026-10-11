import path from "node:path"
import type { Arm } from "./run"

export const OUT = path.join(import.meta.dir, "..", "out", "real")
export const RUN_TAG = process.env.BENCH_TAG
export const RESULTS = RUN_TAG ? path.join(OUT, "runs", RUN_TAG) : OUT
export const PROXIES = path.join(OUT, "proxies")

export const WORK = path.join(OUT, "worktrees")
export const KEEP = path.join(OUT, "continuation")

export const ANSWER_MODEL = process.env.BENCH_ANSWER_MODEL ?? "claude-opus-5-5"
export const ORACLE_MODEL = "claude-opus-5-5"
export const JUDGES = ["claude-opus-5-5", "claude-sonnet-5-5"]

export const SEED = 20261008
export const QUESTIONS = 12
export const REPLICATE = Number(process.env.BENCH_REPLICATE ?? 1)
export const SUFFIX = REPLICATE > 1 ? `.r${REPLICATE}` : ""

export const ARMS: Arm[] = process.env.BENCH_ARMS?.split(",") ?? ["native", "native+guide", "tail", "eunoe", "rolling", "trim", "full"]

export const CONT_ARMS = ARMS.filter((a) => a !== "full")
export const MAX_TURNS = 60
export const TOOLS = "Bash Read Edit Write MultiEdit NotebookEdit Glob Grep WebFetch"
export const DENIED =
  "Bash(git push:*) Bash(gh:*) Bash(npm publish:*) Bash(bun publish:*) Bash(pnpm publish:*) Bash(yarn publish:*) Bash(vercel:*) Bash(wrangler:*) Bash(fly:*) Bash(eas:*) Bash(xcrun altool:*) Bash(xcrun notarytool:*) Bash(fastlane:*) Bash(kubectl:*) Bash(terraform:*) Bash(docker push:*) Bash(curl -X POST:*) Bash(curl --data:*) Agent Task WebSearch"

export const VALIDATE_ARMS = ["native", "native+guide", "tail", "eunoe", "rolling", "trim", "full"] as const
export const VALIDATE_CONT_ARMS = VALIDATE_ARMS.filter((a) => a !== "full")
export const QUESTION_TYPES = ["tool_evidence", "mid_history", "instruction", "decision", "continuation", "recent"]
export const VALIDATE_BUCKETS: Array<[string, (n: number) => boolean]> = [
  ["live", (n) => n === 0],
  ["1-3", (n) => n >= 1 && n <= 3],
  ["4-10", (n) => n >= 4 && n <= 10],
  ["11-25", (n) => n >= 11 && n <= 25],
  ["26+", (n) => n >= 26],
]
export const NON_INFERIORITY = -10
export const BOOTSTRAP = 20_000

export const REPORT_BUCKETS: Array<[string, (n: number) => boolean]> = [
  ["0-3", (n) => n <= 3],
  ["4-10", (n) => n >= 4 && n <= 10],
  ["11-25", (n) => n >= 11 && n <= 25],
  ["26+", (n) => n >= 26],
]

export const GENERATOR = `Below is the complete history of a real coding session, turn by turn, up to the moment its context window filled up. Each turn is labelled with how many turns before the cut it happened, and includes the user's message, what the agent said, every tool call, and the tool output.

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

export const ORACLE = (questions: any[], material: string) => `Below are questions about a coding session, each with the reference answer it expects, followed by the complete session history.

For each question decide one thing: does this history clearly support that reference answer?

"ok" means the evidence is there and the reference answer is right. "bad" means anything else — not in the history, ambiguous, the history contradicts the reference, or it cannot be answered as asked. Be strict: a question that only nearly works is "bad". This filter exists so that no strategy is penalised for a broken question.

Return only JSON: {"verdicts":[{"id":1,"verdict":"ok|bad","why":"<10 words"}, ...]}

=== QUESTIONS ===
${questions.map((q) => `${q.id}. [${q.type}] ${q.question}\n   REFERENCE: ${q.answer}`).join("\n")}

=== SESSION HISTORY ===
${material}`

export const ANSWER = (questions: any[]) => `Stop the current work for a moment: this is a memory check about this session. Do not continue the task and do not change anything.

Answer each question about what happened earlier in this session. Use what is in your context. If it isn't there and you know where this session's transcript is, search it (read-only). Do not inspect the project's files or git history to reconstruct answers — they must come from this conversation. Say you don't know rather than guessing.

${questions.map((q) => `${q.id}. ${q.question}`).join("\n")}

Reply with only JSON: {"answers":[{"id":1,"answer":"...","source":"context|transcript|unknown"}, ...]}`

export const JUDGE = (questions: any[], sets: Record<string, any[]>) => {
  const labels = Object.keys(sets)
  return `Grade answers from ${labels.length} agents to a memory test about a coding session. For each question you get the reference answer and each agent's answer.

For every answer give:
  "score": 2 correct and specific (matches the reference in substance) · 1 partly correct or vague · 0 wrong, missing or declined
  "label": "correct" · "partial" · "unknown" (it said it did not know) · "wrong" (it asserted something the reference contradicts)

Judge only agreement with the reference. Do not reward length, confidence or style. "unknown" and "wrong" both score 0, but they are different failures and must be labelled apart.

${questions.map((q) => [`Q${q.id} (${q.type}): ${q.question}`, `REFERENCE: ${q.answer}`, ...labels.map((l) => `${l}: ${String(sets[l].find((a: any) => a.id === q.id)?.answer ?? "(no answer)").slice(0, 1000)}`)].join("\n")).join("\n\n")}

Reply with only JSON: {"grades":{${labels.map((l) => `"${l}":[{"id":1,"score":0,"label":"unknown"}, …]`).join(",")}}}`
}

export const INSTRUCTIONS = (material: string, claudeMd: string) => `Below is the complete history of a coding session up to the moment its context filled, followed by the CLAUDE.md files that applied to it.

List every standing instruction that was still in force at that moment: things the user told the agent to do or not do (commit or not, which package manager, where to deploy, how to write replies, what to leave alone), rules loaded from a skill the agent invoked, and rules from CLAUDE.md. Only instructions a continuing agent could violate in its very next turn. Each as one short line, with its source.

Return only JSON: {"instructions":[{"id":1,"source":"user|skill|claude_md","text":"..."}, ...]}

=== CLAUDE.md ===
${claudeMd.slice(0, 20_000) || "(none)"}

=== SESSION HISTORY ===
${material}`

export const CONTINUATION_JUDGE = (
  prompt: string,
  reference: string,
  instructions: any[],
  sets: Record<string, string>,
) => `A coding session was compacted and then continued by several agents. You get the user's next message, what the REAL agent did in response at the time (the reference), the standing instructions active at that moment, and what each agent did on the same message after compaction.

Score each agent:
  "fidelity": 2 = it did what the real continuation did, or something defensibly equivalent given the same instruction · 1 = partly, or headed the right way but stopped short or drifted · 0 = did something else, did nothing useful, or asked the user to repeat what the session already settled
  "violations": the ids of standing instructions it broke in this turn (empty list if none)
  "redundant": how many things it redid that were already complete before the cut — re-reading a file it had already edited, re-running a fixed test, re-asking a settled question (0 if none)
  "why": one line

Judge the work against the user's intent and the reference, not against style. An agent that asks a clarifying question the history already answers is not faithful.

=== USER'S MESSAGE ===
${prompt.slice(0, 4000)}

=== REFERENCE: WHAT THE REAL AGENT DID ===
${reference}

=== STANDING INSTRUCTIONS ===
${instructions.map((i) => `${i.id}. [${i.source}] ${i.text}`).join("\n") || "(none)"}

${Object.entries(sets)
  .map(([label, turn]) => `=== AGENT ${label} ===\n${turn}`)
  .join("\n\n")}

Reply with only JSON: {"grades":{${Object.keys(sets)
  .map((l) => `"${l}":{"fidelity":0,"violations":[],"redundant":0,"why":"..."}`)
  .join(",")}}}`

export const EDIT_TOOLS = ["Edit", "Write", "MultiEdit"]
export const READ_TOOLS = ["Read", "Grep", "Glob"]
export const READ_COMMAND = /^(cat|grep|rg|head|tail|sed -n|ls|find|jq|qmd)\b/
