import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { terms } from "../../src/context/recall"
import { splitTurns } from "../../src/context/turns"
import type { Message } from "../../src/context/types"
import { findSessionFile } from "../../src/transcript/locate"
import { sessionMessages } from "../../src/transcript/messages"

export const OUT = path.join(import.meta.dir, "..", "out", "planted")
export const COMPONENTS = path.join(import.meta.dir, "..", "out", "evals")
const REAL = path.join(import.meta.dir, "..", "out", "real")

export interface Plant { turn: number; value: string }
export interface Fact { id: string; type: string; answer: string; stale?: string; plants: Plant[]; question: string; ago: number }
export interface PlantedSession { id: string; split: string; turns: Message[][]; messages: Message[]; facts: Fact[] }
export interface RealQuestion { id: number; type: string; turnsAgo: number; question: string; answer: string }
export interface RealPoint { tag: string; kind: string; turns: Message[][]; messages: Message[]; questions: RealQuestion[] }

export const TOOL_FACTS = new Set(["tool_value", "error", "superseded", "prose_value"])

export function plantedSessions(split?: string): PlantedSession[] {
  const dir = path.join(OUT, "sessions")
  return [...new Bun.Glob("s[0-9][0-9].meta.json").scanSync({ cwd: dir, absolute: true })].sort().flatMap((metaFile) => {
    const meta = JSON.parse(readFileSync(metaFile, "utf8"))
    if (split && meta.split !== split) return []
    const file = metaFile.replace(/\.meta\.json$/, ".jsonl")
    if (!existsSync(file)) return []
    const messages = sessionMessages(file)
    return [{ id: meta.id, split: meta.split, messages, turns: splitTurns(messages).turns, facts: meta.facts }]
  })
}

function configDirs(): string[] {
  const swap = path.join(homedir(), ".claude-swap-backup", "sessions")
  let accounts: string[] = []
  try { accounts = [...new Bun.Glob("*").scanSync({ cwd: swap, onlyFiles: false })].map((d) => path.join(swap, d)) } catch {}
  return [path.join(homedir(), ".claude"), ...accounts]
}

export function realPoints(): RealPoint[] {
  const points = JSON.parse(readFileSync(path.join(REAL, "points.json"), "utf8")) as Array<{ tag: string; kind: string; session: string; cutLine: number }>
  const dirs = configDirs()
  return points.flatMap((point) => {
    const qFile = path.join(REAL, `${point.tag}.questions.json`)
    const file = findSessionFile(point.session, dirs)
    if (!file || !existsSync(qFile)) return []
    const messages: Message[] = []
    for (const line of readFileSync(file, "utf8").split("\n").slice(0, point.cutLine)) {
      if (!line) continue
      let entry: any
      try { entry = JSON.parse(line) } catch { continue }
      if (entry.isSidechain || entry.isCompactSummary || (entry.type !== "user" && entry.type !== "assistant") || !entry.message) continue
      messages.push({ role: entry.message.role, content: entry.message.content })
    }
    const questions = JSON.parse(readFileSync(qFile, "utf8")).questions as RealQuestion[]
    return [{ tag: point.tag, kind: point.kind, messages, turns: splitTurns(messages).turns, questions }]
  })
}

export function keyTokens(answer: string): string[] {
  const all = [...new Set(terms(answer))]
  const strong = all.filter((t) => t.length >= 6 || /\d/.test(t))
  return strong.length ? strong : all.filter((t) => t.length >= 4)
}

export function mentions(text: string, tokens: string[]): boolean {
  const lower = text.toLowerCase()
  return tokens.some((t) => lower.includes(t))
}

export function pct(hits: number, total: number): string {
  return total ? `${Math.round((hits / total) * 100)}%` : "–"
}

export function depthBucket(ago: number): string {
  if (ago <= 3) return "1–3"
  if (ago <= 10) return "4–10"
  if (ago <= 30) return "11–30"
  if (ago <= 60) return "31–60"
  return "61+"
}

export class Tally {
  private counts = new Map<string, { hits: number; total: number }>()
  add(key: string, hit: boolean) {
    const c = this.counts.get(key) ?? { hits: 0, total: 0 }
    c.total += 1
    if (hit) c.hits += 1
    this.counts.set(key, c)
  }
  get(key: string) {
    const c = this.counts.get(key)
    return c ? pct(c.hits, c.total) : "–"
  }
  keys() {
    return [...this.counts.keys()]
  }
  raw(key: string) {
    return this.counts.get(key) ?? { hits: 0, total: 0 }
  }
}
