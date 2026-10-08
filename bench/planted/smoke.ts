/**
 * A tiny fixed session (no model writes it) for checking the run pipeline:
 * resume, compaction, canonical prompt, proxies, scoring. `bun bench/planted/smoke.ts`
 * writes sessions/s99, then: bun bench/planted/run.ts --split=smoke --tag=smoke --arms=...
 */
import { writeFileSync } from "node:fs"
import path from "node:path"
import { SESSIONS, toSessionLines, type Meta, type Turn } from "./generate"

const cwd = path.join(import.meta.dir, "..", "..")
const turns: Turn[] = [
  { turn: 1, user: "what does the proxy do with count_tokens requests", steps: [{ tool: "read", path: "src/proxy/server.ts", offset: 1, limit: 60 }], reply: "count_tokens requests are rewritten like messages but never trigger a cut." },
  { turn: 2, user: "deploy the docs site to staging", steps: [{ tool: "run", command: "bun run deploy:docs --env staging", output: "Building docs...\nUploaded 41 files\nDeployment ID: dpl_k7mq2xv9rt\nLive at https://docs-staging.internal" }], reply: "The docs site is deployed to staging." },
  { turn: 3, user: "from now on every branch must start with the prefix qor/ ok", steps: [{ tool: "git", args: "log --oneline -5" }], reply: "Understood." },
  { turn: 4, user: "run the context tests", steps: [{ tool: "run", command: "bun test test/context.test.ts", output: "running 18 tests\nFAIL test/context.test.ts\n  E_TORNIX_4410: fixture missing\n1 failed, 17 passed", failed: true }, { tool: "read", path: "test/fixtures.ts", limit: 40 }], reply: "One test failed on a missing fixture; I restored it and the suite passes." },
  { turn: 5, user: "ok summarize where we are", steps: [{ tool: "ls", path: "src" }], reply: "Docs are on staging, context tests pass, nothing else pending." },
]
const { lines, tokens } = toSessionLines(turns, { sessionId: crypto.randomUUID(), cwd, model: "claude-opus-5-5", start: Date.parse("2026-09-30T10:00:00Z") })
writeFileSync(path.join(SESSIONS, "s99.jsonl"), lines.join("\n") + "\n")
const meta: Meta = {
  id: "s99", index: 99, split: "smoke" as any, repo: "eunoe", cwd, title: "smoke", style: "", turns: 5, tokens,
  facts: [
    { id: "f01", type: "tool_value", label: "deployment id", answer: "dpl_k7mq2xv9rt", plants: [{ turn: 2, value: "dpl_k7mq2xv9rt" }], brief: "", question: "What deployment ID did the docs staging deploy print?", ago: 4 },
    { id: "f02", type: "instruction", label: "branch prefix", answer: "qor/", plants: [{ turn: 3, value: "qor/" }], implicit: true, brief: "", question: "What prefix must new branches start with?", task: "I need a branch for fixing the count_tokens handling. What exact branch name will you create?", ago: 3 },
    { id: "f03", type: "error", label: "error code", answer: "E_TORNIX_4410", plants: [{ turn: 4, value: "E_TORNIX_4410" }], brief: "", question: "What error code did the failing context test print?", ago: 2 },
  ],
}
writeFileSync(path.join(SESSIONS, "s99.meta.json"), JSON.stringify(meta, null, 2))
console.log(`s99: ${lines.length} lines, ~${tokens} tokens`)
