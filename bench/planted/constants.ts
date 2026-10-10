import { homedir } from "node:os"
import path from "node:path"
import type { Draw, Fact } from "./facts"
import type { Meta, Repo, Turn } from "./generate"

export const PLANT_OUT = path.join(import.meta.dir, "..", "out", "planted")
export const SESSIONS = path.join(PLANT_OUT, "sessions")

export const RUNS = path.join(PLANT_OUT, "runs")
export const NATIVE = path.join(PLANT_OUT, "native")
export const CANON = path.join(PLANT_OUT, "canon")
export const TRANSCRIPTS = path.join(PLANT_OUT, "transcripts")

export const GENERATOR_MODEL = "claude-opus-5-5"
export const CHUNK = 12
export const CLAUDE_VERSION = "2.1.287"

export const ANSWER_MODEL = "claude-sonnet-5-5"
export const CUT_SHARE = 0.95

export const PROJECTS = path.join(homedir(), "Developer", "Projects")
export const SUPERWALL = path.join(homedir(), "Developer", "Superwall")
export const REPOS = [
  path.join(PROJECTS, "kanna"), path.join(PROJECTS, "buzzkit"), path.join(PROJECTS, "cs"), path.join(PROJECTS, "feedbase"),
  path.join(PROJECTS, "marcato"), path.join(PROJECTS, "outpost"), path.join(PROJECTS, "tripline"), path.join(PROJECTS, "madori"),
  path.join(PROJECTS, "sen"), path.join(PROJECTS, "shinsa"), path.join(SUPERWALL, "pwn"), path.join(SUPERWALL, "ios"),
]
export const STYLES = [
  "terse and lowercase, few words, occasional typos, no greetings",
  "clear full sentences, polite, explains the why behind requests",
  "mixed: sometimes a one-liner, sometimes a paragraph of context; casual, a bit impatient",
]
export const TEXT = /\.(ts|tsx|js|jsx|mjs|swift|py|go|rs|md|json|css|scss|html|yml|yaml|toml|sql|sh|kt)$/

export const DEPTH_BUCKETS: Array<[string, number, number]> = [
  ["1-3", 1, 3],
  ["4-10", 4, 10],
  ["11-30", 11, 30],
  ["31-60", 31, 60],
  ["61+", 61, 1_000],
]

export const SYLLABLES = ["ka", "ri", "mo", "tez", "vul", "dra", "pen", "sho", "gal", "nix", "oro", "bel", "quin", "zar", "lum", "fen", "tor", "wex", "yal", "cus"]
export const CODENAMES = ["Heron", "Marten", "Osprey", "Tamarin", "Gecko", "Ibex", "Kestrel", "Lynx", "Narwhal", "Ocelot", "Pika", "Quokka", "Saiga", "Tapir", "Vicuna", "Wombat", "Yak", "Zorilla", "Caracal", "Dhole", "Eland", "Fossa", "Gharial", "Hoatzin"]
export const B32 = "abcdefghjkmnpqrstuvwxyz23456789"

export const VALUE_KINDS: Array<(v: Draw) => { label: string; value: string }> = [
  (v) => ({ label: "the deployment ID printed by a staging deploy", value: `dpl_${v.b32(10)}` }),
  (v) => ({ label: "the build hash printed by a release build", value: v.hex(12) }),
  (v) => ({ label: "the migration version applied by a database migration", value: `${v.int(2024, 2026)}${String(v.int(1, 12)).padStart(2, "0")}${String(v.int(1, 28)).padStart(2, "0")}_${v.word(2)}` }),
  (v) => ({ label: "the request ID of a failing API call in a log excerpt", value: `req_${v.b32(14)}` }),
  (v) => ({ label: "the number of rows a backfill script reported updating", value: String(v.int(10_000, 999_999)) }),
  (v) => ({ label: "the preview URL a deploy printed", value: `https://${v.word(2)}-${v.b32(6)}.preview.internal` }),
  (v) => ({ label: "the trace ID from a profiler run", value: v.hex(16) }),
  (v) => ({ label: "the job ID a queued background task printed", value: `job-${v.int(100_000, 999_999)}-${v.b32(4)}` }),
  (v) => ({ label: "the checksum a bundle step printed", value: `sha256:${v.hex(10)}` }),
  (v) => ({ label: "the p95 latency in milliseconds from a load test", value: `${v.int(101, 989)}.${v.int(1, 9)}ms` }),
]
export const ERROR_KINDS: Array<(v: Draw) => { label: string; value: string }> = [
  (v) => ({ label: "the error code a failing test run printed", value: `E_${v.word(2).toUpperCase()}_${v.int(1000, 9999)}` }),
  (v) => ({ label: "the error code a failed deploy printed", value: `DEPLOY_${v.word(1).toUpperCase()}${v.int(100, 999)}` }),
  (v) => ({ label: "the exit code and signal name a crashed worker printed", value: `SIG${v.word(1).toUpperCase()}${v.int(10, 99)}` }),
]
export const INSTRUCTION_KINDS: Array<(v: Draw) => { label: string; value: string; brief: (value: string) => string }> = [
  (v) => ({ label: "the prefix every new git branch must start with", value: `${v.word(1)}${v.word(1)}/`, brief: (x) => `every new git branch must start with the prefix \`${x}\`` }),
  (v) => ({ label: "the port the local dev server must run on", value: String(v.int(3100, 9899)), brief: (x) => `the local dev server must always run on port ${x}, never the default` }),
  (v) => ({ label: "the tag every commit message must end with", value: `[${v.word(2)}]`, brief: (x) => `every commit message must end with the tag \`${x}\`` }),
  (v) => ({ label: "the shard flag the test suite must always be run with", value: `--shard=${v.int(2, 9)}/${v.int(10, 16)}`, brief: (x) => `the test suite must always be run with the flag \`${x}\`` }),
  (v) => ({ label: "the prefix every new feature flag name must use", value: `ff_${v.word(2)}_`, brief: (x) => `every new feature flag name must start with \`${x}\`` }),
  (v) => ({ label: "the region deploys must target", value: `${v.word(1)}-${v.int(1, 9)}`, brief: (x) => `deploys must only ever target the region \`${x}\`` }),
  (v) => ({ label: "the reviewer handle every PR must be assigned to", value: `@${v.word(2)}${v.int(1, 99)}`, brief: (x) => `every PR must be assigned to the reviewer \`${x}\`` }),
  (v) => ({ label: "the environment variable that must be set before running scripts", value: `${v.word(2).toUpperCase()}_MODE=strict`, brief: (x) => `scripts must always be run with \`${x}\` set in the environment` }),
]

export const SUPERSEDED_BEFORE = /(?:old|older|previous|former|earlier|replac\w*|instead of|rather than|no longer|not|n.t|over|from|was|were|used to|superseded|dropped|rejected|ruled out|than)\W*(?:\w+\W+){0,4}$/
export const SUPERSEDED_AFTER = /^\W*(?:\w+\W+){0,3}?(?:is|was|has been|got)?\W*(?:no longer|replaced|superseded|retired|dropped|rejected|out|old|obsolete|deprecated)\b/

export const SMOKE_CWD = path.join(import.meta.dir, "..", "..")
export const SMOKE_TURNS: Turn[] = [
  { turn: 1, user: "what does the proxy do with count_tokens requests", steps: [{ tool: "read", path: "src/proxy/server.ts", offset: 1, limit: 60 }], reply: "count_tokens requests are rewritten like messages but never trigger a cut." },
  { turn: 2, user: "deploy the docs site to staging", steps: [{ tool: "run", command: "bun run deploy:docs --env staging", output: "Building docs...\nUploaded 41 files\nDeployment ID: dpl_k7mq2xv9rt\nLive at https://docs-staging.internal" }], reply: "The docs site is deployed to staging." },
  { turn: 3, user: "from now on every branch must start with the prefix qor/ ok", steps: [{ tool: "git", args: "log --oneline -5" }], reply: "Understood." },
  { turn: 4, user: "run the context tests", steps: [{ tool: "run", command: "bun test test/context.test.ts", output: "running 18 tests\nFAIL test/context.test.ts\n  E_TORNIX_4410: fixture missing\n1 failed, 17 passed", failed: true }, { tool: "read", path: "test/fixtures.ts", limit: 40 }], reply: "One test failed on a missing fixture; I restored it and the suite passes." },
  { turn: 5, user: "ok summarize where we are", steps: [{ tool: "ls", path: "src" }], reply: "Docs are on staging, context tests pass, nothing else pending." },
]

export const OUTLINE = (repo: Repo, files: string[], turns: number, style: string) => `You are planning a realistic, long working session between a developer and a coding agent (Claude Code) in the repository "${repo.name}". It runs ${turns} turns: each turn is one message from the developer and the agent's work on it.

Make it feel like a real day of work on THIS codebase: a few threads of feature work, a debugging detour or two, refactors, test runs, small chores, a release or deploy, questions about how something works. Threads continue across many turns and some get interrupted and resumed later. Topics should reference real files and areas from the list below.

The developer's style: ${style}.

Return only JSON: {"title":"...","topics":["<turn 1 topic in one line>", ... exactly ${turns} items]}

README (start):
${repo.readme.slice(0, 3000)}

Files (sample):
${files.join("\n")}`

export const CHUNK_PROMPT = (o: {
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

export const TASKS = (facts: Meta["facts"]) => `A few quick things before we carry on. Don't run or change anything for these, just answer each one in a sentence or two, as you actually would do it right now.

${facts.map((f) => `${f.id}. ${f.task}`).join("\n")}

Reply with only JSON: {"replies":[{"id":"${facts[0]?.id}","reply":"..."}, ...]}`

export const RECALL = (facts: Meta["facts"]) => `Stop the current work for a moment: this is a memory check about this session. Do not continue the task and do not change anything.

Answer each question about what happened earlier in this session. Use what is in your context. If it isn't there and you know where this session's transcript is, search it (read-only). Do not inspect the project's files or git history to reconstruct answers; they must come from this conversation. If you don't know, answer "unknown" rather than guessing.

Give only the exact value each question asks for (an ID, a number, a name, a flag, a prefix), copied exactly, with no explanation.

${facts.map((f) => `${f.id}. ${f.question}`).join("\n")}

Reply with only JSON: {"answers":[{"id":"${facts[0]?.id}","answer":"..."}, ...]}`
