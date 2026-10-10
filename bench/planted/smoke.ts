import { writeFileSync } from "node:fs"
import path from "node:path"
import { toSessionLines, type Meta } from "./generate"
import { SESSIONS, SMOKE_CWD, SMOKE_TURNS } from "./constants"

const { lines, tokens } = toSessionLines(SMOKE_TURNS, { sessionId: crypto.randomUUID(), cwd: SMOKE_CWD, model: "claude-opus-5-5", start: Date.parse("2026-09-30T10:00:00Z") })
writeFileSync(path.join(SESSIONS, "s99.jsonl"), lines.join("\n") + "\n")
const meta: Meta = {
  id: "s99", index: 99, split: "smoke" as any, repo: "eunoe", cwd: SMOKE_CWD, title: "smoke", style: "", turns: 5, tokens,
  facts: [
    { id: "f01", type: "tool_value", label: "deployment id", answer: "dpl_k7mq2xv9rt", plants: [{ turn: 2, value: "dpl_k7mq2xv9rt" }], brief: "", question: "What deployment ID did the docs staging deploy print?", ago: 4 },
    { id: "f02", type: "instruction", label: "branch prefix", answer: "qor/", plants: [{ turn: 3, value: "qor/" }], implicit: true, brief: "", question: "What prefix must new branches start with?", task: "I need a branch for fixing the count_tokens handling. What exact branch name will you create?", ago: 3 },
    { id: "f03", type: "error", label: "error code", answer: "E_TORNIX_4410", plants: [{ turn: 4, value: "E_TORNIX_4410" }], brief: "", question: "What error code did the failing context test print?", ago: 2 },
  ],
}
writeFileSync(path.join(SESSIONS, "s99.meta.json"), JSON.stringify(meta, null, 2))
console.log(`s99: ${lines.length} lines, ~${tokens} tokens`)
