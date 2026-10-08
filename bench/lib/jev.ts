import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const KEY_FILE = path.join(homedir(), ".config", "eunoe-bench", "typesafe-key")
const ENDPOINT = "https://api.typesafe.ai/v1/systemone"

export const JEV_BLOCK = 255
export const JEV_MAX_LINES = 1_000

export interface JevStats { calls: number; tokens: number; ms: number[] }
export const jevStats = new Map<string, JevStats>()

export interface JevNoul { type: "noul"; instructions: string }
export interface JevChoice { type: "choice"; instructions: string; criteria: Record<string, string | null> }
export type JevQuestion = JevNoul | JevChoice
export interface JevAnswers { [key: string]: { type: "noul"; noul: number } | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> } }

export async function jev(model: string, state: string, questions: Record<string, JevQuestion>): Promise<JevAnswers> {
  const key = (process.env.TYPESAFE_API_KEY ?? readFileSync(KEY_FILE, "utf8")).trim()
  const stats = jevStats.get(model) ?? { calls: 0, tokens: 0, ms: [] }
  jevStats.set(model, stats)
  for (let attempt = 0; ; attempt += 1) {
    const t0 = performance.now()
    const response = await fetch(ENDPOINT, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model, state, questions }) })
    const json: any = await response.json().catch(() => ({}))
    if (response.ok) {
      stats.calls += 1
      stats.tokens += json.usage?.input_tokens ?? 0
      stats.ms.push(performance.now() - t0)
      return json.answers
    }
    if ((response.status === 429 || response.status === 529) && attempt < 6) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
      continue
    }
    throw new Error(`jev ${response.status}: ${JSON.stringify(json).slice(0, 300)}`)
  }
}

export const lineId = (i: number) => `L${String(i).padStart(4, "0")}`
export const lineIndex = (id: string) => Number(id.slice(1))

export function blocks(lines: string[]): Array<Array<[number, string]>> {
  const shown: Array<[number, string]> = lines.length <= JEV_MAX_LINES ? lines.map((l, i) => [i, l]) : [...lines.slice(0, JEV_MAX_LINES / 2).map((l, i) => [i, l] as [number, string]), ...lines.slice(-JEV_MAX_LINES / 2).map((l, i) => [lines.length - JEV_MAX_LINES / 2 + i, l] as [number, string])]
  const kept = shown.filter(([, l]) => l.trim().length >= 2)
  const out: Array<Array<[number, string]>> = []
  for (let i = 0; i < kept.length; i += JEV_BLOCK) out.push(kept.slice(i, i + JEV_BLOCK))
  return out
}

export const EVIDENCE_CATEGORIES: Array<[string, string, string]> = [
  ["error", "This output contains an error, failure, exception or warning line", "Which line is the main error, failure or warning message?"],
  ["status", "This output contains a final status or result line, such as deployed to, N passed, N failed, exit code, done, created, published", "Which line states the final status or result of the command?"],
  ["ident", "This output prints an identifier a developer may need to recall later: an id, hash, URL, version number, token, key, host or resource name", "Which line prints the most important identifier (id, hash, URL, version, name)?"],
  ["measure", "This output prints a measurement, count or amount: a duration, size, row count, test count, price or percentage", "Which line prints the most important measurement, count or amount?"],
  ["change", "This output names a file, path, migration, table, branch or resource that was created, changed, applied or deleted", "Which line names what was created, changed, applied or deleted?"],
]

export function evidenceQuestions(block: Array<[number, string]>): Record<string, JevQuestion> {
  const criteria = Object.fromEntries(block.map(([i]) => [lineId(i), null]))
  const questions: Record<string, JevQuestion> = {}
  for (const [name, gate, which] of EVIDENCE_CATEGORIES) {
    questions[`${name}_has`] = { type: "noul", instructions: gate }
    questions[`${name}_line`] = { type: "choice", instructions: which, criteria }
  }
  return questions
}

export function evidencePicks(answers: JevAnswers, gate = 0.5, floor = 0.2, perCategory = 3, cap = 12): number[] {
  const best = new Map<number, number>()
  for (const [name] of EVIDENCE_CATEGORIES) {
    const has = answers[`${name}_has`]
    const line = answers[`${name}_line`]
    if (!has || has.type !== "noul" || has.noul < gate || !line || line.type !== "choice") continue
    const ranked = Object.entries(line.probabilities).filter(([, p]) => p >= floor).sort((a, b) => b[1] - a[1]).slice(0, perCategory)
    for (const [id, p] of ranked) best.set(lineIndex(id), Math.max(best.get(lineIndex(id)) ?? 0, p))
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([i]) => i)
}
