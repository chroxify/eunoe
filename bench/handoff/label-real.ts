import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { claude } from "../lib/claude"
import { NO_TOOLS } from "../lib/constants"
import { extractJson } from "../lib/json"
import { realCases, type Label, type RealCase } from "./real-cases"
import { HANDOFF_OUT, LABELS_FILE, LABEL_MODEL } from "./constants"

const PARALLEL = Number(process.argv.find((a) => a.startsWith("--parallel="))?.slice(11) ?? 4)
const labels: Record<string, Label> = existsSync(LABELS_FILE) ? JSON.parse(readFileSync(LABELS_FILE, "utf8")) : {}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …` : s)
const PROMPT = (c: RealCase) => `A developer starts a new Claude Code session. Decide whether this session continues the work of one of their earlier sessions in the same project.

"Continues" means the same feature, bug, investigation or piece of work: knowing what happened in that earlier session would directly help this one (decisions made, code written, errors seen, rules given). Working in the same repo or the same general area is NOT enough. If the new session starts different work, answer none. Be strict: a wrong "continues" would inject unrelated history into the new session.

NEW SESSION (every message the developer sent, in order):
${clip(c.session.outline, 4000)}

EARLIER SESSIONS (most recent first):
${c.candidates.map((a) => `--- id ${a.id.slice(0, 8)}${a.title ? ` · ${a.title}` : ""}\n${clip(a.outline, 1800)}`).join("\n\n")}

Return only JSON: {"source":"<8-char id of the one session it continues, or none>","partial":["<ids that are related but not the same work>"],"why":"<one short sentence>"}`

const todo = realCases().filter((c) => !labels[c.id])
console.log(`${todo.length} cases to label (${Object.keys(labels).length} cached)`)
let next = 0
let done = 0
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  for (;;) {
    const c = todo[next++]
    if (!c) return
    const out = await claude(["--model", LABEL_MODEL, ...NO_TOOLS], { cwd: HANDOFF_OUT, stdin: PROMPT(c), account: process.env.BENCH_CSWAP_ACCOUNT })
    try {
      const json = extractJson(String(out.result ?? ""))
      const short = (id: string) => c.candidates.find((a) => a.id.startsWith(String(id)))?.id ?? null
      labels[c.id] = { source: json.source && json.source !== "none" ? short(json.source) : null, partial: (json.partial ?? []).map(short).filter(Boolean), why: String(json.why ?? "") }
      writeFileSync(LABELS_FILE, JSON.stringify(labels, null, 1))
    } catch {
      console.log(`unparsed ${c.id.slice(0, 8)}: ${String(out.result).slice(0, 120)}`)
    }
    if (++done % 20 === 0) console.log(`${done}/${todo.length}`)
  }
}))
console.log("done")
