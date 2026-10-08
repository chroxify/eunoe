import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { rank, recallChunks, renderRecall, terms } from "../../src/context/recall"
import type { RecallChunk, RecallPick } from "../../src/context/types"
import { COMPONENTS, Tally, TOOL_FACTS, keyTokens, mentions, pct, plantedSessions, realPoints } from "../lib/data"
import { jev, jevStats } from "../lib/jev"

type Ranker = (question: string, chunks: RecallChunk[], corpusKey: string) => Promise<number[]>
interface Arm { name: string; rank: Ranker; prepare?: (chunks: RecallChunk[], corpusKey: string) => Promise<void> }

const TOP = Number(process.env.RETRIEVAL_TOP ?? 12)
const CANDIDATES = Number(process.env.RETRIEVAL_CANDIDATES ?? 30)
const split = process.argv[2] ?? "all"
const armFilter = (process.env.RETRIEVAL_ARMS ?? "").split(",").filter(Boolean)
const CACHE = path.join(COMPONENTS, "embed-cache")
const API_KEY_FILE = path.join(homedir(), ".config", "eunoe-bench", "api-key")

const chunkText = (c: RecallChunk) => `${c.call}\n${c.lines.join("\n")}`.slice(0, 1_200)
const corpusHash = (chunks: RecallChunk[]) => createHash("sha1").update(chunks.map(chunkText).join("\u0000")).digest("hex").slice(0, 12)

const EMBEDDERS: Record<string, { model: string; query: string; doc: string; pooling: "mean" | "cls"; dtype?: string }> = {
  minilm: { model: "Xenova/all-MiniLM-L6-v2", query: "", doc: "", pooling: "mean" },
  "bge-small": { model: "Xenova/bge-small-en-v1.5", query: "Represent this sentence for searching relevant passages: ", doc: "", pooling: "cls" },
  "bge-base": { model: "Xenova/bge-base-en-v1.5", query: "Represent this sentence for searching relevant passages: ", doc: "", pooling: "cls" },
  "e5-small": { model: "Xenova/e5-small-v2", query: "query: ", doc: "passage: ", pooling: "mean" },
  "gte-small": { model: "Xenova/gte-small", query: "", doc: "", pooling: "mean" },
  nomic: { model: "nomic-ai/nomic-embed-text-v1.5", query: "search_query: ", doc: "search_document: ", pooling: "mean", dtype: "fp32" },
}
const CROSS_ENCODERS: Record<string, string> = {
  "ce-minilm": "Xenova/ms-marco-MiniLM-L-6-v2",
  "ce-bge": "Xenova/bge-reranker-base",
  "ce-mxbai": "mixedbread-ai/mxbai-rerank-xsmall-v1",
}

const transformers = () => import(path.join(import.meta.dir, "..", "tools", "models", "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs"))

const pipes = new Map<string, any>()
async function embedder(key: string) {
  if (pipes.has(key)) return pipes.get(key)
  const { pipeline } = await transformers()
  const spec = EMBEDDERS[key]
  const pipe = await pipeline("feature-extraction", spec.model, { dtype: spec.dtype ?? "fp32" })
  pipes.set(key, pipe)
  return pipe
}

async function embed(key: string, texts: string[], prefix: string): Promise<Float32Array[]> {
  const pipe = await embedder(key)
  const out: Float32Array[] = []
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32).map((t) => prefix + t)
    const result = await pipe(batch, { pooling: EMBEDDERS[key].pooling, normalize: true, truncation: true, max_length: 256 })
    const [n, d] = result.dims
    const data = result.data as Float32Array
    for (let r = 0; r < n; r += 1) out.push(data.slice(r * d, (r + 1) * d))
  }
  return out
}

const docCache = new Map<string, Float32Array[]>()
async function docVectors(key: string, chunks: RecallChunk[], corpusKey: string): Promise<Float32Array[]> {
  const id = `${key}:${corpusKey}`
  if (docCache.has(id)) return docCache.get(id)!
  const dir = path.join(CACHE, key)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${corpusKey}.bin`)
  let vectors: Float32Array[]
  if (existsSync(file)) {
    const all = new Float32Array(readFileSync(file).buffer.slice(0))
    const d = all.length / chunks.length
    vectors = chunks.map((_, i) => all.slice(i * d, (i + 1) * d))
  } else {
    const t0 = Date.now()
    vectors = await embed(key, chunks.map(chunkText), EMBEDDERS[key].doc)
    const d = vectors[0]?.length ?? 0
    const flat = new Float32Array(vectors.length * d)
    vectors.forEach((v, i) => flat.set(v, i * d))
    writeFileSync(file, Buffer.from(flat.buffer))
    indexMs.set(key, (indexMs.get(key) ?? 0) + Date.now() - t0)
    indexed.set(key, (indexed.get(key) ?? 0) + chunks.length)
  }
  docCache.set(id, vectors)
  return vectors
}

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]; return s }

function denseRank(key: string): Ranker {
  return async (question, chunks, corpusKey) => {
    const docs = await docVectors(key, chunks, corpusKey)
    const [q] = await embed(key, [question], EMBEDDERS[key].query)
    return docs.map((v, index) => ({ index, score: dot(q, v) })).sort((a, b) => b.score - a.score).map((r) => r.index)
  }
}

function bm25Rank(minTerms = 1): Ranker {
  return async (question, chunks) => rank(terms(question), chunks, minTerms).map((r) => r.index)
}

function rrf(lists: number[][], k = 60): number[] {
  const score = new Map<number, number>()
  for (const list of lists) list.forEach((index, r) => score.set(index, (score.get(index) ?? 0) + 1 / (k + r + 1)))
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i)
}

function hybrid(key: string): Ranker {
  const dense = denseRank(key)
  return async (question, chunks, corpusKey) => rrf([await bm25Rank()(question, chunks, corpusKey), (await dense(question, chunks, corpusKey)).slice(0, 200)])
}

const ceModels = new Map<string, { tokenizer: any; model: any }>()
async function crossEncoder(key: string) {
  if (ceModels.has(key)) return ceModels.get(key)!
  const { AutoTokenizer, AutoModelForSequenceClassification } = await transformers()
  const name = CROSS_ENCODERS[key]
  const tokenizer = await AutoTokenizer.from_pretrained(name)
  const model = await AutoModelForSequenceClassification.from_pretrained(name, { dtype: "fp32" })
  ceModels.set(key, { tokenizer, model })
  return { tokenizer, model }
}

function ceRerank(key: string, base: Ranker = bm25Rank()): Ranker {
  return async (question, chunks, corpusKey) => {
    const candidates = (await base(question, chunks, corpusKey)).slice(0, CANDIDATES)
    if (!candidates.length) return []
    const { tokenizer, model } = await crossEncoder(key)
    const scores: number[] = []
    for (let i = 0; i < candidates.length; i += 16) {
      const batch = candidates.slice(i, i + 16)
      const inputs = tokenizer(batch.map(() => question), { text_pair: batch.map((c) => chunkText(chunks[c])), padding: true, truncation: true, max_length: 384 })
      const { logits } = await model(inputs)
      const [n, d] = logits.dims
      for (let r = 0; r < n; r += 1) scores.push(d === 1 ? logits.data[r] : logits.data[r * d + d - 1])
    }
    return candidates.map((index, i) => ({ index, score: scores[i] })).sort((a, b) => b.score - a.score).map((r) => r.index)
  }
}

const llmCache: Record<string, Record<string, number[]>> = {}
function llmCacheFile(model: string) { return path.join(COMPONENTS, `rerank-cache.${model.replace(/[^\w.-]/g, "_")}.json`) }
async function llmPick(model: string, question: string, chunks: RecallChunk[], candidates: number[], pick: number, call: (prompt: string) => Promise<string>): Promise<number[]> {
  const file = llmCacheFile(model)
  llmCache[model] ??= existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
  const key = `${question}\n${candidates.map((i) => `${chunks[i].turn}:${chunks[i].call}:${chunks[i].lines[0]}`).join("|")}`
  if (llmCache[model][key]) return llmCache[model][key]
  const listing = candidates.map((index, n) => `### ${n}\n[turn ${chunks[index].turn}] ${chunks[index].call}\n${chunks[index].lines.map((l) => l.slice(0, 240)).join("\n")}`).join("\n\n")
  const prompt = `A developer is asking a question about an earlier part of a coding session. Below are numbered excerpts of tool output and agent notes from that session. Return the numbers of up to ${pick} excerpts most likely to contain the exact answer, best first, as a JSON array of integers and nothing else. Return [] if none could.\n\nQuestion: ${question}\n\n${listing}`
  const text = await call(prompt)
  const picked = (JSON.parse(text.match(/\[[^\]]*\]/)?.[0] ?? "[]") as number[]).filter((n) => Number.isInteger(n) && n >= 0 && n < candidates.length).slice(0, pick).map((n) => candidates[n])
  llmCache[model][key] = picked
  writeFileSync(file, JSON.stringify(llmCache[model]))
  llmCalls.set(model, (llmCalls.get(model) ?? 0) + 1)
  return picked
}

async function anthropic(model: string, prompt: string, maxTokens = 60): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": readFileSync(API_KEY_FILE, "utf8").trim(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  })
  const json: any = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(json).slice(0, 300))
  llmTokens.set(model, (llmTokens.get(model) ?? 0) + (json.usage?.input_tokens ?? 0))
  return json.content?.[0]?.text ?? ""
}

async function ollama(model: string, prompt: string): Promise<string> {
  const response = await fetch("http://127.0.0.1:11434/api/generate", { method: "POST", body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, num_predict: 80 } }) })
  const json: any = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(json).slice(0, 300))
  return json.response ?? ""
}

function llmRerank(label: string, call: (prompt: string) => Promise<string>, pick = 4, base: Ranker = bm25Rank()): Ranker {
  return async (question, chunks, corpusKey) => {
    const candidates = (await base(question, chunks, corpusKey)).slice(0, CANDIDATES)
    if (!candidates.length) return []
    const picked = await llmPick(label, question, chunks, candidates, pick, call)
    return [...picked, ...candidates.filter((c) => !picked.includes(c))]
  }
}

function jevRerank(model: string, base: Ranker = bm25Rank()): Ranker {
  const label = model
  return async (question, chunks, corpusKey) => {
    const candidates = (await base(question, chunks, corpusKey)).slice(0, CANDIDATES)
    if (!candidates.length) return []
    const file = llmCacheFile(label)
    llmCache[label] ??= existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
    const key = `${question}\n${candidates.map((i) => `${chunks[i].turn}:${chunks[i].call}:${chunks[i].lines[0]}`).join("|")}`
    let order = llmCache[label][key]
    if (!order) {
      const state = candidates.map((index, n) => `### ${n}\n[turn ${chunks[index].turn}] ${chunks[index].call}\n${chunks[index].lines.map((l) => l.slice(0, 240)).join("\n")}`).join("\n\n")
      const answers = await jev(model, state, {
        where: { type: "choice", instructions: `Which excerpt contains the exact answer to the developer's question about this coding session: "${question}"?`, criteria: Object.fromEntries(candidates.map((_, n) => [String(n), null])) },
        exists: { type: "noul", instructions: `At least one excerpt contains the exact answer to: "${question}"` },
      })
      const where = answers.where
      const probs = where.type === "choice" ? where.probabilities : {}
      order = candidates.map((_, n) => n).sort((a, b) => (probs[String(b)] ?? 0) - (probs[String(a)] ?? 0) || a - b)
      llmCache[label][key] = order
      writeFileSync(file, JSON.stringify(llmCache[label]))
    }
    return order.map((n) => candidates[n])
  }
}

const rewriteCache: Record<string, string> = existsSync(path.join(COMPONENTS, "rewrite-cache.json")) ? JSON.parse(readFileSync(path.join(COMPONENTS, "rewrite-cache.json"), "utf8")) : {}
function rewriteThenBm25(model: string): Ranker {
  return async (question, chunks) => {
    const key = `${model}\n${question}`
    if (!rewriteCache[key]) {
      rewriteCache[key] = await anthropic(model, `A developer asks a question about an earlier coding session. Write the words most likely to appear in the exact command output or log line that answers it: command names, flags, file names, identifiers, error words, units. One line, 8–20 words, no punctuation, no explanation.\n\nQuestion: ${question}`, 80)
      writeFileSync(path.join(COMPONENTS, "rewrite-cache.json"), JSON.stringify(rewriteCache))
      llmCalls.set(`rewrite:${model}`, (llmCalls.get(`rewrite:${model}`) ?? 0) + 1)
    }
    return rank([...terms(question), ...terms(rewriteCache[key])], chunks, 1).map((r) => r.index)
  }
}

const indexMs = new Map<string, number>()
const indexed = new Map<string, number>()
const llmCalls = new Map<string, number>()
const llmTokens = new Map<string, number>()

const ARMS: Arm[] = [
  { name: "bm25", rank: bm25Rank(2) },
  { name: "bm25 min1", rank: bm25Rank(1) },
  ...Object.keys(EMBEDDERS).map((k) => ({ name: `dense:${k}`, rank: denseRank(k) })),
  ...Object.keys(EMBEDDERS).map((k) => ({ name: `hybrid:${k}`, rank: hybrid(k) })),
  ...Object.keys(CROSS_ENCODERS).map((k) => ({ name: `${k} over bm25`, rank: ceRerank(k) })),
  { name: "ce-minilm over hybrid:bge-small", rank: ceRerank("ce-minilm", hybrid("bge-small")) },
  { name: "haiku rerank", rank: llmRerank("claude-haiku-4-5-20251001", (p) => anthropic("claude-haiku-4-5-20251001", p)) },
  { name: "haiku rerank over hybrid:bge-small", rank: llmRerank("claude-haiku-4-5-20251001", (p) => anthropic("claude-haiku-4-5-20251001", p), 4, hybrid("bge-small")) },
  { name: "sonnet rerank", rank: llmRerank("claude-sonnet-5-5", (p) => anthropic("claude-sonnet-5-5", p)) },
  { name: "haiku rewrite → bm25", rank: rewriteThenBm25("claude-haiku-4-5-20251001") },
  ...(process.env.OLLAMA_MODELS ?? "").split(",").filter(Boolean).map((m) => ({ name: `ollama:${m} rerank`, rank: llmRerank(`ollama_${m}`, (p) => ollama(m, p)) })),
  ...(process.env.JEV_MODELS ?? "jev-latest").split(",").filter(Boolean).flatMap((m) => [{ name: `${m} rerank`, rank: jevRerank(m) }, { name: `${m} rerank over hybrid:bge-small`, rank: jevRerank(m, hybrid("bge-small")) }]),
].filter((a) => !armFilter.length || armFilter.some((f) => a.name.includes(f)))

interface Ask { question: string; hit: (text: string) => boolean; type: string; corpusKey: string; chunks: RecallChunk[]; planted: boolean }
const asks: Ask[] = []
for (const session of plantedSessions(split === "all" ? undefined : split)) {
  const chunks = recallChunks([...session.messages, { role: "user", content: "" }], new Map())
  const corpusKey = `${session.id}-${corpusHash(chunks)}`
  for (const fact of session.facts) {
    if (!TOOL_FACTS.has(fact.type)) continue
    if (!chunks.some((c) => c.lines.join("\n").includes(fact.answer))) continue
    asks.push({ question: fact.question, hit: (t) => t.includes(fact.answer), type: fact.type, corpusKey, chunks, planted: true })
  }
}
for (const point of realPoints()) {
  const chunks = recallChunks([...point.messages, { role: "user", content: "" }], new Map())
  const corpusKey = `${point.tag}-${corpusHash(chunks)}`
  for (const q of point.questions) {
    if (q.type === "continuation") continue
    const tokens = keyTokens(q.answer)
    if (!chunks.some((c) => mentions(c.lines.join("\n"), tokens))) continue
    asks.push({ question: q.question, hit: (t) => mentions(t, tokens), type: q.type, corpusKey, chunks, planted: false })
  }
}
console.error(`${asks.length} questions (${asks.filter((a) => a.planted).length} planted, ${asks.filter((a) => !a.planted).length} real), ${[...new Set(asks.map((a) => a.corpusKey))].length} corpora, ${[...new Map(asks.map((a) => [a.corpusKey, a.chunks.length])).values()].reduce((s, n) => s + n, 0)} chunks; arms: ${ARMS.map((a) => a.name).join(", ")}`)

const results: Record<string, { planted: Tally; real: Tally; cand12: Tally; cand30: Tally; ms: number[]; chars: number[] }> = {}
for (const arm of ARMS) {
  const r = { planted: new Tally(), real: new Tally(), cand12: new Tally(), cand30: new Tally(), ms: [] as number[], chars: [] as number[] }
  results[arm.name] = r
  let n = 0
  for (const ask of asks) {
    const t0 = performance.now()
    let ranked: number[]
    try { ranked = await arm.rank(ask.question, ask.chunks, ask.corpusKey) } catch (e) { console.error(`${arm.name}: ${String(e).slice(0, 200)}`); break }
    r.ms.push(performance.now() - t0)
    const holds = (i: number) => ask.hit(ask.chunks[i].lines.join("\n"))
    r.cand12.add(ask.planted ? "planted" : "real", ranked.slice(0, TOP).some(holds))
    r.cand30.add(ask.planted ? "planted" : "real", ranked.slice(0, CANDIDATES).some(holds))
    const q = new Set(terms(ask.question))
    const picks: RecallPick[] = ranked.slice(0, TOP).map((index) => ({ index, query: q }))
    const injected = renderRecall(ask.question, ask.chunks, picks) ?? ""
    r.chars.push(injected.length)
    const hit = ask.hit(injected)
    ;(ask.planted ? r.planted : r.real).add(ask.type, hit)
    ;(ask.planted ? r.planted : r.real).add("all", hit)
    n += 1
    if (n % 200 === 0) console.error(`  ${arm.name}: ${n}/${asks.length}`)
  }
  console.error(`${arm.name}: planted ${r.planted.get("all")} real ${r.real.get("all")} (median ${med(r.ms).toFixed(0)}ms/query)`)
}

function med(xs: number[]) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
const plantedKeys = ["tool_value", "error", "prose_value", "superseded", "all"]
const realKeys = ["tool_evidence", "recent", "mid_history", "decision", "instruction", "all"]
const lines: string[] = []
lines.push(`# Recall retrieval: rankers compared (${split})`, "")
lines.push(`Same corpus (6-line windows + agent narrative), same rendering (top ${TOP}, salient excerpt, default budgets), same exact-match hit. Rerankers re-order the base ranker's top ${CANDIDATES}. ${asks.filter((a) => a.planted).length} planted questions, ${asks.filter((a) => !a.planted).length} real.`, "")
lines.push("## Hit rate inside the injected context", "")
lines.push(`| arm | planted ${plantedKeys.join(" | ")} | real ${realKeys.join(" | ")} |`, `|${"---|".repeat(plantedKeys.length + realKeys.length + 1)}`)
for (const [name, r] of Object.entries(results)) lines.push(`| ${name} | ${plantedKeys.map((k) => r.planted.get(k)).join(" | ")} | ${realKeys.map((k) => r.real.get(k)).join(" | ")} |`)
lines.push("", "## Ranking quality and cost", "")
lines.push(`| arm | answer within top ${TOP} (planted / real) | within top ${CANDIDATES} (planted / real) | ms per query (median / p95) | injected chars (median) | index ms per 1k chunks | model calls | input tokens |`, "|---|---|---|---|---|---|---|---|")
for (const [name, r] of Object.entries(results)) {
  const sorted = [...r.ms].sort((a, b) => a - b)
  const key = name.replace(/^(dense|hybrid):/, "")
  const idx = indexMs.has(key) ? Math.round((indexMs.get(key)! / Math.max(1, indexed.get(key)!)) * 1000) : "–"
  const model = name.includes("sonnet") ? "claude-sonnet-5-5" : name.includes("haiku rewrite") ? "rewrite:claude-haiku-4-5-20251001" : name.includes("haiku") ? "claude-haiku-4-5-20251001" : name.startsWith("ollama:") ? `ollama_${name.slice(7).replace(" rerank", "")}` : name.match(/^(jev-[\w.-]+)/)?.[1] ?? ""
  const jv = jevStats.get(model)
  lines.push(`| ${name} | ${r.cand12.get("planted")} / ${r.cand12.get("real")} | ${r.cand30.get("planted")} / ${r.cand30.get("real")} | ${med(r.ms).toFixed(0)} / ${(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(0)} | ${med(r.chars)} | ${idx} | ${model ? (jv ? jv.calls : llmCalls.get(model) ?? 0) : "–"} | ${model ? (jv ? jv.tokens : llmTokens.get(model.replace(/^rewrite:/, "")) ?? "–") : "–"} |`)
}
mkdirSync(COMPONENTS, { recursive: true })
const out = path.join(COMPONENTS, `retrieval.${split}${armFilter.length ? `.${armFilter.join("+").replace(/[^\w+-]/g, "_")}` : ""}.md`)
writeFileSync(out, lines.join("\n") + "\n")
console.log(lines.join("\n"))
console.log(`\nwritten ${out}`)
