import { blocks, clip, describeToolCall, type Message, resultText, textOf } from "../content"
import { isSalient, toolPairs } from "../fold/evidence"
import { isPrompt, splitTurns } from "../fold/turns"
import { recalledContext } from "../prompts"

export interface RecallChunk {
  turn: number
  from?: string
  call: string
  lines: string[]
  terms: string[]
}

export interface RecallOptions {
  windowLines?: number
  perQuery?: number
  minTerms?: number
  maxChars?: number
  maxCharsMulti?: number
  narrative?: boolean
  callWeight?: number
  salientExcerpt?: boolean
  candidates?: number
}

export interface RecallPick {
  index: number
  query: Set<string>
}

export type Reranker = (query: string, chunks: RecallChunk[], candidates: number[]) => Promise<number[]>

const SHOWN_LINES = 8
const BM25_K1 = 1.2
const BM25_B = 0.75

const STOPWORDS = new Set(
  "the and for with that this what which when where who how was were did does done from into onto have has had you your our out not but are can could would should will just then than them they there their its it's about after before again also any each other some such only own same very more most over under while because been being into".split(
    " ",
  ),
)

export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_@$][a-z0-9_.:/@$-]*[a-z0-9_]|[a-z0-9]/g) ?? []).flatMap((term) => (/[._:/-]/.test(term) ? [term, ...term.split(/[._:/-]+/)] : [term])).filter((term) => term.length >= 3 && !STOPWORDS.has(term))
}

function windows(lines: string[], size: number): string[][] {
  const out: string[][] = []
  for (let start = 0; start < lines.length; start += size) out.push(lines.slice(start, start + size))
  return out
}

export function recallChunks(messages: Message[], keptIds: Map<string, string>, options: RecallOptions = {}): RecallChunk[] {
  const size = options.windowLines ?? 6
  const weight = Math.max(1, options.callWeight ?? 1)
  const chunks: RecallChunk[] = []
  splitTurns(messages)
    .turns.slice(0, -1)
    .forEach((turn, turnIndex) => {
      for (const { call, result } of toolPairs(turn)) {
        const text = resultText(result)
        if (keptIds.get(call.id) === text || !text.trim()) continue
        const head = describeToolCall(call)
        const headTerms = Array.from({ length: weight }, () => terms(head)).flat()
        for (const window of windows(text.split("\n"), size)) chunks.push({ turn: turnIndex + 1, call: head, lines: window, terms: [...headTerms, ...terms(window.join("\n"))] })
      }
      if (!(options.narrative ?? true)) return
      const said = turn
        .slice(1, -1)
        .filter((m) => m.role === "assistant")
        .flatMap((m) =>
          blocks(m)
            .filter((b) => b.type === "text")
            .map((b) => String(b.text ?? "").trim()),
        )
        .filter(Boolean)
      for (const window of windows(said.join("\n").split("\n"), size)) chunks.push({ turn: turnIndex + 1, call: "agent", lines: window, terms: terms(window.join("\n")) })
    })
  return chunks
}

export function rank(query: string[], chunks: RecallChunk[], minTerms = 2) {
  const df = new Map<string, number>()
  for (const chunk of chunks) for (const term of new Set(chunk.terms)) df.set(term, (df.get(term) ?? 0) + 1)
  const average = chunks.reduce((s, c) => s + c.terms.length, 0) / Math.max(1, chunks.length)
  const wanted = [...new Set(query)].filter((t) => df.has(t))
  return chunks
    .map((chunk, index) => {
      const tf = new Map<string, number>()
      for (const term of chunk.terms) tf.set(term, (tf.get(term) ?? 0) + 1)
      let score = 0
      let matched = 0
      for (const term of wanted) {
        const f = tf.get(term) ?? 0
        if (!f) continue
        matched += 1
        const n = df.get(term) ?? 0
        const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5))
        score += (idf * (f * (BM25_K1 + 1))) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * chunk.terms.length) / average))
      }
      return { index, score, matched }
    })
    .filter((r) => r.matched >= Math.min(minTerms, wanted.length) && r.score > 0)
    .sort((a, b) => b.score - a.score)
}

function excerpt(chunk: RecallChunk, query: Set<string>, salient: boolean): string[] {
  const limit = salient ? SHOWN_LINES + 2 : SHOWN_LINES
  const shown = new Set<number>()
  chunk.lines.forEach((line, i) => {
    if (!terms(line).some((t) => query.has(t))) return
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < chunk.lines.length) shown.add(j)
  })
  if (salient) for (let i = 0; i < chunk.lines.length && shown.size < limit; i += 1) if (isSalient(chunk.lines[i])) shown.add(i)
  const ordered = [...shown].sort((a, b) => a - b).slice(0, limit)
  return (ordered.length > 0 ? ordered : [0]).map((i) => clip(chunk.lines[i], 240)).filter(Boolean)
}

function queriesOf(prompt: string): string[] {
  const lines = prompt
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => terms(l).length >= 2)
  return lines.length > 1 ? lines : [prompt]
}

function merged(hits: Array<{ query: string[]; indices: number[] }>): RecallPick[] {
  const picked = new Map<number, Set<string>>()
  for (const { query, indices } of hits) {
    for (const index of indices) {
      const matched = picked.get(index) ?? new Set()
      for (const term of query) matched.add(term)
      picked.set(index, matched)
    }
  }
  return [...picked.entries()].map(([index, query]) => ({ index, query }))
}

const ranked = (query: string[], chunks: RecallChunk[], options: RecallOptions, width: number) =>
  rank(query, chunks, options.minTerms)
    .slice(0, width)
    .map((hit) => hit.index)

function pickRecall(prompt: string, chunks: RecallChunk[], options: RecallOptions): RecallPick[] {
  return merged(
    queriesOf(prompt).map((line) => {
      const query = terms(line)
      return { query, indices: ranked(query, chunks, options, options.perQuery ?? 12) }
    }),
  )
}

export const identityReranker: Reranker = async (_query, _chunks, candidates) => candidates

export async function pickRecallWith(prompt: string, chunks: RecallChunk[], rerank: Reranker, options: RecallOptions = {}): Promise<RecallPick[]> {
  const hits: Array<{ query: string[]; indices: number[] }> = []
  for (const line of queriesOf(prompt)) {
    const query = terms(line)
    const reordered = await rerank(line, chunks, ranked(query, chunks, options, options.candidates ?? 30))
    hits.push({ query, indices: reordered.slice(0, options.perQuery ?? 12) })
  }
  return merged(hits)
}

export function renderRecall(prompt: string, chunks: RecallChunk[], picks: RecallPick[], options: RecallOptions = {}): string | null {
  if (picks.length === 0) return null
  const budget = queriesOf(prompt).length > 1 ? (options.maxCharsMulti ?? 30_000) : (options.maxChars ?? 18_000)
  const entries: string[] = []
  let used = 0
  for (const { index, query } of [...picks].sort((a, b) => chunks[a.index].turn - chunks[b.index].turn || a.index - b.index)) {
    const chunk = chunks[index]
    const where = chunk.from ? `${chunk.from}, turn ${chunk.turn}` : `turn ${chunk.turn}`
    const lines = excerpt(chunk, query, options.salientExcerpt ?? true).map((l) => `    ${l}`)
    const entry = `[${where}] ${chunk.call}:\n${lines.join("\n")}`
    if (used + entry.length > budget) continue
    entries.push(entry)
    used += entry.length
  }
  if (entries.length === 0) return null
  return recalledContext(
    entries,
    picks.some((p) => Boolean(chunks[p.index].from)),
  )
}

export function recallFor(prompt: string, chunks: RecallChunk[], options: RecallOptions = {}): string | null {
  if (chunks.length === 0) return null
  return renderRecall(prompt, chunks, pickRecall(prompt, chunks, options), options)
}

export async function recallForWith(prompt: string, chunks: RecallChunk[], rerank: Reranker, options: RecallOptions = {}): Promise<string | null> {
  if (chunks.length === 0) return null
  return renderRecall(prompt, chunks, await pickRecallWith(prompt, chunks, rerank, options), options)
}

export function livePrompt(messages: Message[]): { index: number; text: string } | null {
  const { preamble, turns } = splitTurns(messages)
  const live = turns.at(-1)
  if (!live || !isPrompt(live[0])) return null
  const index = preamble.length + turns.slice(0, -1).reduce((s, t) => s + t.length, 0)
  const text = textOf(live[0])
    .replace(/<(system-reminder|system-message|recalled-context|tool-evidence|handoff)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, "")
    .trim()
  return { index, text }
}

export function withRecall(messages: Message[], fingerprint: (message: Message) => string, recalls: Record<string, string>): Message[] {
  if (Object.keys(recalls).length === 0) return messages
  return messages.map((message) => {
    if (!isPrompt(message)) return message
    const text = recalls[fingerprint(message)]
    return text ? { ...message, content: [...blocks(message), { type: "text", text }] } : message
  })
}
