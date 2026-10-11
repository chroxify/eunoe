import { statSync } from "node:fs"
import path from "node:path"
import { type Message, textOf } from "../../context/content"
import { isPrompt, splitTurns } from "../../context/fold/turns"
import { type RecallChunk, rank, terms } from "../../context/recall"
import { cwdOf, seenSessions, titleOf } from "../../proxy/sessions"
import { findSessionFile, listEntries, projectFolderName } from "../../transcript/locate"
import { sessionMessages } from "../../transcript/messages"

export interface SessionCandidate {
  id: string
  file: string
  label: string
  mtime: number
  asks: string[]
  outline: string
  messages: Message[]
}

export const SESSION_SOURCE_MIN_TURNS = 2
export const SESSION_SOURCE_CANDIDATES = 12
export const SESSION_MIN_TERMS = 2

const promptText = (message: Message) =>
  textOf(message)
    .replace(/<[a-z-]+(?:\s[^>]*)?>[\s\S]*?<\/[a-z-]+>/g, "")
    .trim()

export function outlineOf(messages: Message[]): string[] {
  return splitTurns(messages)
    .turns.filter((turn) => isPrompt(turn[0]))
    .map((turn) => promptText(turn[0]))
    .filter(Boolean)
    .map((text) => text.slice(0, 240))
}

function sessionFiles(sessionId: string, cwd: string, configDirs: string[]): Array<{ id: string; file: string; mtime: number }> {
  const files = new Map<string, { file: string; mtime: number }>()
  const add = (id: string, file: string) => {
    if (id === sessionId || files.has(id)) return
    try {
      files.set(id, { file, mtime: statSync(file).mtimeMs })
    } catch {}
  }
  for (const [id, seen] of seenSessions()) {
    if (seen.cwd !== cwd) continue
    const file = findSessionFile(id, configDirs)
    if (file) add(id, file)
  }
  for (const dir of configDirs) {
    const folder = path.join(dir, "projects", projectFolderName(cwd))
    for (const name of listEntries(folder)) if (name.endsWith(".jsonl")) add(name.slice(0, -".jsonl".length), path.join(folder, name))
  }
  return [...files].map(([id, entry]) => ({ id, ...entry })).sort((a, b) => b.mtime - a.mtime)
}

export function sessionCandidates(sessionId: string, cwd: string, configDirs: string[]): SessionCandidate[] {
  const out: SessionCandidate[] = []
  for (const { id, file, mtime } of sessionFiles(sessionId, cwd, configDirs)) {
    const recorded = cwdOf(file)
    if (recorded && recorded !== cwd) continue
    const messages = sessionMessages(file)
    const asks = outlineOf(messages)
    if (asks.length < SESSION_SOURCE_MIN_TURNS) continue
    out.push({ id, file, label: titleOf(file) ?? "", mtime, asks, outline: asks.map((ask, i) => `${i + 1}. ${ask}`).join("\n"), messages })
    if (out.length >= SESSION_SOURCE_CANDIDATES) break
  }
  return out
}

export function rankCandidates(prompt: string, candidates: SessionCandidate[]): SessionCandidate[] {
  const chunks: RecallChunk[] = candidates.map((cand, i) => ({ turn: i, call: cand.id, lines: [cand.outline], terms: terms(cand.outline) }))
  return rank(terms(prompt), chunks, SESSION_MIN_TERMS).map((r) => candidates[r.index])
}
