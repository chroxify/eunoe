import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { outlineOf, SESSION_SOURCE_CANDIDATES, SESSION_SOURCE_MIN_TURNS } from "../../src/cli/sessions/source"
import { sessionMessages } from "../../src/transcript/messages"
import { sessionRoots } from "../lib/points"

export interface RealSession {
  id: string
  project: string
  start: number
  title: string
  prompts: string[]
  outline: string
}
export interface RealCase {
  id: string
  project: string
  prompt: string
  session: RealSession
  candidates: RealSession[]
}
export interface Label {
  source: string | null
  partial: string[]
  why: string
}

function startOf(file: string): { start: number; title: string } {
  let start = 0
  let title = ""
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!start) {
      const m = line.match(/"timestamp":"([^"]+)"/)
      if (m) start = Date.parse(m[1])
    }
    if (!title && line.includes('"aiTitle"')) {
      try {
        title = JSON.parse(line).aiTitle ?? ""
      } catch {}
    }
    if (start && title) break
  }
  return { start, title }
}

function load(file: string, project: string): RealSession | null {
  let prompts: string[]
  try {
    prompts = outlineOf(sessionMessages(file))
  } catch {
    return null
  }
  if (prompts.length === 0) return null
  const { start, title } = startOf(file)
  return { id: path.basename(file, ".jsonl"), project, start, title, prompts, outline: prompts.map((l, i) => `${i + 1}. ${l}`).join("\n") }
}

const isCopy = (a: RealSession, b: RealSession) => a.prompts[0] === b.prompts[0] && (a.prompts[1] ?? "") === (b.prompts[1] ?? "")

export function realCases(): RealCase[] {
  const projects = new Map<string, Map<string, RealSession>>()
  for (const root of sessionRoots())
    for (const project of readdirSync(root)) {
      let names: string[]
      try {
        names = readdirSync(path.join(root, project)).filter((f) => f.endsWith(".jsonl"))
      } catch {
        continue
      }
      const group = projects.get(project) ?? new Map<string, RealSession>()
      for (const name of names) {
        if (group.has(name.slice(0, -6))) continue
        const s = load(path.join(root, project, name), project)
        if (s?.start) group.set(s.id, s)
      }
      projects.set(project, group)
    }
  const cases: RealCase[] = []
  for (const [project, group] of projects) {
    const all = [...group.values()].sort((a, b) => a.start - b.start)
    const sessions = all.filter((s, i) => !all.slice(0, i).some((a) => isCopy(a, s)))
    for (const [i, s] of sessions.entries()) {
      const candidates = sessions
        .slice(0, i)
        .filter((a) => a.prompts.length >= SESSION_SOURCE_MIN_TURNS)
        .reverse()
        .slice(0, SESSION_SOURCE_CANDIDATES)
      if (candidates.length > 0) cases.push({ id: s.id, project, prompt: s.prompts[0], session: s, candidates })
    }
  }
  return cases
}

export const half = (id: string) => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 2
