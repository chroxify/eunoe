import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { rank, recallChunks, renderRecall, terms } from "../../src/context/recall"
import type { RecallChunk, RecallPick } from "../../src/context/types"
import { COMPONENTS, Tally, TOOL_FACTS, keyTokens, mentions, pct, plantedSessions, realPoints } from "../lib/data"

const MODEL = process.env.RERANK_MODEL ?? "claude-haiku-4-5-20251001"
const CANDIDATES = Number(process.env.RERANK_CANDIDATES ?? 30)
const PICK = Number(process.env.RERANK_PICK ?? 4)
const API_KEY = readFileSync(path.join(homedir(), ".config", "eunoe-bench", "api-key"), "utf8").trim()
const split = process.argv[2] ?? "dev"
const cacheFile = path.join(COMPONENTS, `rerank-cache.${MODEL}.json`)
const cache: Record<string, number[]> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {}
let calls = 0
let inputTokens = 0

async function rerank(question: string, chunks: RecallChunk[], candidates: number[]): Promise<number[]> {
  const key = `${question}\n${candidates.map((i) => `${chunks[i].turn}:${chunks[i].call}:${chunks[i].lines[0]}`).join("|")}`
  if (cache[key]) return cache[key]
  const listing = candidates.map((index, n) => `### ${n}\n[turn ${chunks[index].turn}] ${chunks[index].call}\n${chunks[index].lines.map((l) => l.slice(0, 240)).join("\n")}`).join("\n\n")
  const prompt = `A developer is asking a question about an earlier part of a coding session. Below are numbered excerpts of tool output from that session. Return the numbers of up to ${PICK} excerpts most likely to contain the exact answer, best first, as a JSON array of integers and nothing else. Return [] if none could.\n\nQuestion: ${question}\n\n${listing}`
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 60, messages: [{ role: "user", content: prompt }] }),
  })
  const json: any = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(json).slice(0, 300))
  calls += 1
  inputTokens += json.usage?.input_tokens ?? 0
  const text: string = json.content?.[0]?.text ?? "[]"
  const picked = (JSON.parse(text.match(/\[[^\]]*\]/)?.[0] ?? "[]") as number[]).filter((n) => Number.isInteger(n) && n >= 0 && n < candidates.length).slice(0, PICK).map((n) => candidates[n])
  cache[key] = picked
  writeFileSync(cacheFile, JSON.stringify(cache))
  return picked
}

const tally = new Tally()
const realTally = new Tally()
const chunkTally = new Tally()
const narrativeOpts = { narrative: true }

for (const session of plantedSessions(split)) {
  const chunks = recallChunks([...session.messages, { role: "user", content: "" }], new Map(), narrativeOpts)
  for (const fact of session.facts) {
    if (!TOOL_FACTS.has(fact.type)) continue
    const q = terms(fact.question)
    const candidates = rank(q, chunks, 1).slice(0, CANDIDATES).map((r) => r.index)
    const inCandidates = candidates.some((i) => chunks[i].lines.join("\n").includes(fact.answer))
    chunkTally.add("planted: answer within BM25 top-30", inCandidates)
    const picked = await rerank(fact.question, chunks, candidates)
    const picks: RecallPick[] = picked.map((index) => ({ index, query: new Set(q) }))
    const injected = renderRecall(fact.question, chunks, picks, { maxChars: 12_000, maxCharsMulti: 24_000, salientExcerpt: true }) ?? ""
    const hit = injected.includes(fact.answer)
    tally.add(fact.type, hit)
    tally.add("all", hit)
    chunkTally.add("planted: picked chunk holds answer", picked.some((i) => chunks[i].lines.join("\n").includes(fact.answer)))
  }
  console.error(`${session.id} done (${calls} calls, ${Math.round(inputTokens / 1000)}k input tokens)`)
}

for (const point of realPoints()) {
  const chunks = recallChunks([...point.messages, { role: "user", content: "" }], new Map(), narrativeOpts)
  for (const q of point.questions) {
    if (q.type === "continuation") continue
    const tokens = keyTokens(q.answer)
    if (!chunks.some((c) => mentions(c.lines.join("\n"), tokens))) continue
    const qt = terms(q.question)
    const candidates = rank(qt, chunks, 1).slice(0, CANDIDATES).map((r) => r.index)
    chunkTally.add("real: answer within BM25 top-30", candidates.some((i) => mentions(chunks[i].lines.join("\n"), tokens)))
    const picked = await rerank(q.question, chunks, candidates)
    const picks: RecallPick[] = picked.map((index) => ({ index, query: new Set(qt) }))
    const injected = renderRecall(q.question, chunks, picks, { maxChars: 12_000, maxCharsMulti: 24_000, salientExcerpt: true }) ?? ""
    const hit = mentions(injected, tokens)
    realTally.add(q.type, hit)
    realTally.add("all", hit)
  }
  console.error(`${point.tag} done (${calls} calls, ${Math.round(inputTokens / 1000)}k input tokens)`)
}

const lines: string[] = []
lines.push(`# Recall with a model reranker (${MODEL}, BM25 top-${CANDIDATES} → model picks ≤${PICK})`, "")
lines.push(`Planted (${split} split): | ${["tool_value", "error", "prose_value", "superseded", "all"].map((k) => `${k} ${tally.get(k)}`).join(" | ")} |`)
lines.push(`Real: | ${["tool_evidence", "recent", "mid_history", "decision", "instruction", "all"].map((k) => `${k} ${realTally.get(k)}`).join(" | ")} |`)
for (const k of chunkTally.keys()) lines.push(`${k}: ${chunkTally.get(k)} (${chunkTally.raw(k).hits}/${chunkTally.raw(k).total})`)
lines.push(`Model calls: ${calls}, input tokens: ${inputTokens}`)
mkdirSync(COMPONENTS, { recursive: true })
writeFileSync(path.join(COMPONENTS, `rerank.${split}.md`), lines.join("\n") + "\n")
console.log(lines.join("\n"))
