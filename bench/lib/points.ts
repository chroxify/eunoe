/**
 * Find benchmark points: the first auto-compaction of a main session whose
 * project dir still exists and that has enough history before the cut.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type Entry = Record<string, any>

export interface Point {
  file: string
  sessionId: string
  cwd: string
  lines: string[]
  entries: Entry[]
  boundaryIndex: number
  preTokens: number
  turnsBefore: number
  mtimeMs: number
}

export function sessionRoots(): string[] {
  const home = homedir()
  const roots = [path.join(home, ".claude", "projects")]
  const accounts = path.join(home, ".kanna", "data", "claude-accounts")
  try {
    for (const account of readdirSync(accounts)) roots.push(path.join(accounts, account, "projects"))
  } catch {}
  return roots.filter(existsSync)
}

export function blocks(message: any): any[] {
  const content = message?.content
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : []
}

export function isPromptEntry(entry: Entry) {
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary || entry.isSidechain) return false
  const content = blocks(entry.message)
  return content.some((block) => block.type === "text" || block.type === "image") && !content.some((block) => block.type === "tool_result")
}

export const parse = (lines: string[]): Entry[] => lines.map((l) => { try { return JSON.parse(l) } catch { return {} } })

export function textOf(entry: Entry) {
  return blocks(entry.message).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n")
}

export const clean = (raw: string) => raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<system-message>[\s\S]*?<\/system-message>/g, "").trim()

/** A user turn a person typed: not a tool result, not a slash command, not an interruption marker. */
export function realPrompt(entry: Entry) {
  if (!isPromptEntry(entry)) return false
  const p = clean(textOf(entry))
  return Boolean(p) && !p.startsWith("[Request interrupted") && !p.startsWith("<local-command") && !p.startsWith("<command-")
}

export function findPoints(): Point[] {
  const points: Point[] = []
  for (const root of sessionRoots()) {
    for (const project of readdirSync(root)) {
      const dir = path.join(root, project)
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue
        const file = path.join(dir, name)
        const stat = statSync(file)
        if (stat.size < 1_000_000 || Date.now() - stat.mtimeMs > 60 * 86_400_000) continue
        const text = readFileSync(file, "utf8")
        if (!text.includes('"compact_boundary"')) continue
        const lines = text.split("\n").filter(Boolean)
        const entries = lines.map((line) => { try { return JSON.parse(line) } catch { return {} } })
        const boundaryIndex = entries.findIndex((entry) => entry.subtype === "compact_boundary")
        const boundary = entries[boundaryIndex]
        if (boundary?.compactMetadata?.trigger !== "auto") continue
        const cwd = entries.find((entry) => typeof entry.cwd === "string")?.cwd
        if (!cwd || !existsSync(cwd)) continue
        const turnsBefore = entries.slice(0, boundaryIndex).filter(isPromptEntry).length
        const hasAfter = entries.slice(boundaryIndex).some(isPromptEntry)
        if (turnsBefore < 8 || !hasAfter) continue
        points.push({
          file, sessionId: name.replace(/\.jsonl$/, ""), cwd, lines, entries, boundaryIndex,
          preTokens: boundary.compactMetadata.preTokens ?? 0, turnsBefore, mtimeMs: stat.mtimeMs,
        })
      }
    }
  }
  return points.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

if (import.meta.main) {
  const points = findPoints()
  console.log(`${points.length} points`)
  for (const point of points) {
    console.log(`${new Date(point.mtimeMs).toISOString().slice(0, 10)}  ${String(point.turnsBefore).padStart(4)} turns  ${Math.round(point.preTokens / 1000)}k  ${point.cwd}`)
  }
}
