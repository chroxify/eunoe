import { BM25_B, BM25_K1, RECALL_LINE_CHARS, RECALL_MAX_CHARS, RECALL_MAX_CHARS_MULTI, RECALL_MIN_TERMS, RECALL_NARRATIVE, RECALL_PER_QUERY, RECALL_RERANK_CANDIDATES, RECALL_SALIENT_EXCERPT, RECALL_SHOWN_LINES, RECALL_WINDOW_LINES, STOPWORDS } from "./constants"
import { blocks, clip, describeToolCall, resultText } from "./content"
import { isSalient, toolPairs } from "./evidence"
import { isPrompt, splitTurns } from "./turns"
import type { Message, RecallChunk, RecallOptions, RecallPick, Reranker } from "./types"

const REMINDERS = /<(system-reminder|system-message|recalled-context|tool-evidence)>[\s\S]*?<\/\1>/g

export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_@$][a-z0-9_.:/@$-]*[a-z0-9_]|[a-z0-9]/g) ?? [])
    .flatMap((term) => (/[._:/-]/.test(term) ? [term, ...term.split(/[._:/-]+/)] : [term]))
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term))
}

function promptText(message: Message): string {
  return blocks(message).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").replace(REMINDERS, "").trim()
}

function windows(lines: string[], size: number): string[][] {
  const out: string[][] = []
  for (let start = 0; start < lines.length; start += size) out.push(lines.slice(start, start + size))
  return out
}

export function recallChunks(messages: Message[], keptIds: Map<string, string>, options: RecallOptions = {}): RecallChunk[] {
  const { turns } = splitTurns(messages)
  const size = options.windowLines ?? RECALL_WINDOW_LINES
  const weight = Math.max(1, options.callWeight ?? 1)
  const chunks: RecallChunk[] = []
  turns.slice(0, -1).forEach((turn, turnIndex) => {
    for (const { call, result } of toolPairs(turn)) {
      const text = resultText(result)
      if (keptIds.get(call.id) === text || !text.trim()) continue
      const head = describeToolCall(call)
      const headTerms = Array.from({ length: weight }, () => terms(head)).flat()
      for (const window of windows(text.split("\n"), size)) {
        chunks.push({ turn: turnIndex + 1, call: head, lines: window, terms: [...headTerms, ...terms(window.join("\n"))] })
      }
    }
    if (!(options.narrative ?? RECALL_NARRATIVE)) return
    const said = turn.slice(1, -1).filter((m) => m.role === "assistant").flatMap((m) => blocks(m).filter((b) => b.type === "text").map((b) => String(b.text ?? "").trim())).filter(Boolean)
    for (const window of windows(said.join("\n").split("\n"), size)) {
      chunks.push({ turn: turnIndex + 1, call: "agent", lines: window, terms: terms(window.join("\n")) })
    }
  })
  return chunks
}

export function rank(query: string[], chunks: RecallChunk[], minTerms = RECALL_MIN_TERMS) {
  const df = new Map<string, number>()
  for (const chunk of chunks) for (const term of new Set(chunk.terms)) df.set(term, (df.get(term) ?? 0) + 1)
  const average = chunks.reduce((s, c) => s + c.terms.length, 0) / Math.max(1, chunks.length)
  const wanted = [...new Set(query)].filter((t) => df.has(t))
  return chunks.map((chunk, index) => {
    const tf = new Map<string, number>()
    for (const term of chunk.terms) tf.set(term, (tf.get(term) ?? 0) + 1)
    let score = 0
    let matched = 0
    for (const term of wanted) {
      const f = tf.get(term) ?? 0
      if (!f) continue
      matched += 1
      const idf = Math.log(1 + (chunks.length - df.get(term)! + 0.5) / (df.get(term)! + 0.5))
      score += idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * chunk.terms.length / average))
    }
    return { index, score, matched }
  }).filter((r) => r.matched >= Math.min(minTerms, wanted.length) && r.score > 0).sort((a, b) => b.score - a.score)
}

function excerpt(chunk: RecallChunk, query: Set<string>, salient: boolean): string[] {
  const hits = chunk.lines.map((line, i) => (terms(line).some((t) => query.has(t)) ? i : -1)).filter((i) => i >= 0)
  const shown = new Set<number>()
  for (const i of hits) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < chunk.lines.length) shown.add(j)
  if (salient) for (let i = 0; i < chunk.lines.length && shown.size < RECALL_SHOWN_LINES + 2; i += 1) if (isSalient(chunk.lines[i])) shown.add(i)
  const ordered = [...shown].sort((a, b) => a - b).slice(0, salient ? RECALL_SHOWN_LINES + 2 : RECALL_SHOWN_LINES)
  return (ordered.length ? ordered : [0]).map((i) => clip(chunk.lines[i], RECALL_LINE_CHARS)).filter(Boolean)
}

export function queriesOf(prompt: string): string[] {
  const lines = prompt.split("\n").map((l) => l.trim()).filter((l) => terms(l).length >= 2)
  return lines.length > 1 ? lines : [prompt]
}

export function pickRecall(prompt: string, chunks: RecallChunk[], options: RecallOptions = {}): RecallPick[] {
  const perQuery = options.perQuery ?? RECALL_PER_QUERY
  const picked = new Map<number, Set<string>>()
  for (const query of queriesOf(prompt)) {
    const q = terms(query)
    for (const hit of rank(q, chunks, options.minTerms).slice(0, perQuery)) {
      if (!picked.has(hit.index)) picked.set(hit.index, new Set())
      for (const t of q) picked.get(hit.index)!.add(t)
    }
  }
  return [...picked.entries()].map(([index, query]) => ({ index, query }))
}

export async function pickRecallWith(prompt: string, chunks: RecallChunk[], rerank: Reranker, options: RecallOptions = {}): Promise<RecallPick[]> {
  const perQuery = options.perQuery ?? RECALL_PER_QUERY
  const width = options.candidates ?? RECALL_RERANK_CANDIDATES
  const picked = new Map<number, Set<string>>()
  for (const query of queriesOf(prompt)) {
    const q = terms(query)
    const candidates = rank(q, chunks, options.minTerms).slice(0, width).map((hit) => hit.index)
    for (const index of (await rerank(query, chunks, candidates)).slice(0, perQuery)) {
      if (!picked.has(index)) picked.set(index, new Set())
      for (const t of q) picked.get(index)!.add(t)
    }
  }
  return [...picked.entries()].map(([index, query]) => ({ index, query }))
}

export function renderRecall(prompt: string, chunks: RecallChunk[], picks: RecallPick[], options: RecallOptions = {}): string | null {
  if (!picks.length) return null
  const budget = queriesOf(prompt).length > 1 ? options.maxCharsMulti ?? RECALL_MAX_CHARS_MULTI : options.maxChars ?? RECALL_MAX_CHARS
  const entries: string[] = []
  let used = 0
  for (const pick of [...picks].sort((a, b) => chunks[a.index].turn - chunks[b.index].turn || a.index - b.index)) {
    const chunk = chunks[pick.index]
    const entry = `[turn ${chunk.turn}] ${chunk.call}:\n${excerpt(chunk, pick.query, options.salientExcerpt ?? RECALL_SALIENT_EXCERPT).map((l) => `    ${l}`).join("\n")}`
    if (used + entry.length > budget) continue
    entries.push(entry)
    used += entry.length
  }
  return entries.length
    ? `<recalled-context>\nExcerpts from earlier in this session that match this message: tool output that is no longer in your context, quoted exactly, oldest first. Where the same thing appears twice, the later turn is current. Use them if they answer what was asked; ignore them otherwise.\n\n${entries.join("\n")}\n</recalled-context>`
    : null
}

export function recallFor(prompt: string, chunks: RecallChunk[], options: RecallOptions = {}): string | null {
  if (!chunks.length) return null
  return renderRecall(prompt, chunks, pickRecall(prompt, chunks, options), options)
}

export async function recallForWith(prompt: string, chunks: RecallChunk[], rerank: Reranker, options: RecallOptions = {}): Promise<string | null> {
  if (!chunks.length) return null
  return renderRecall(prompt, chunks, await pickRecallWith(prompt, chunks, rerank, options), options)
}

export function livePrompt(messages: Message[]): { index: number; text: string } | null {
  const { preamble, turns } = splitTurns(messages)
  if (turns.length < 2) return null
  const first = turns.at(-1)![0]
  if (!isPrompt(first)) return null
  const index = preamble.length + turns.slice(0, -1).reduce((s, t) => s + t.length, 0)
  return { index, text: promptText(first) }
}

export function withRecall(messages: Message[], fingerprint: (message: Message) => string, recalls: Record<string, string>): Message[] {
  if (!Object.keys(recalls).length) return messages
  return messages.map((message) => {
    if (!isPrompt(message)) return message
    const text = recalls[fingerprint(message)]
    return text ? { ...message, content: [...blocks(message), { type: "text", text }] } : message
  })
}
