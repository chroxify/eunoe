import { readdirSync, statSync } from "node:fs"
import path from "node:path"
import { INJECTED_TAGS, SESSION_MIN_TERMS, SESSION_OUTLINE_CHARS, SESSION_SOURCE_CANDIDATES, SESSION_SOURCE_MIN_TURNS } from "../context/constants"
import { blocks } from "../context/content"
import { rank, terms } from "../context/recall"
import { isPrompt, splitTurns } from "../context/turns"
import type { Message, RecallChunk } from "../context/types"
import { sessionMessages } from "../transcript/messages"
import { findSessionFile } from "../transcript/locate"
import { cwdOf, seenSessions, titleOf } from "../proxy/sessions"

export interface SessionCandidate {
  id: string
  file: string
  label: string
  mtime: number
  asks: string[]
  outline: string
  messages: Message[]
}

const promptText = (message: Message) => blocks(message).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").replace(INJECTED_TAGS, "").trim()

export function outlineOf(messages: Message[]): string[] {
  const { turns } = splitTurns(messages)
  return turns.filter((turn) => isPrompt(turn[0])).map((turn) => promptText(turn[0])).filter(Boolean).map((text) => text.slice(0, SESSION_OUTLINE_CHARS))
}

export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-")
}

export function sessionCandidates(sessionId: string, cwd: string, configDirs: string[]): SessionCandidate[] {
  const files = new Map<string, { file: string; mtime: number }>()
  const add = (id: string, file: string) => {
    if (id === sessionId || files.has(id)) return
    try { files.set(id, { file, mtime: statSync(file).mtimeMs }) } catch {}
  }
  for (const [id, seen] of seenSessions()) {
    if (seen.cwd !== cwd) continue
    const file = findSessionFile(id, configDirs)
    if (file) add(id, file)
  }
  for (const dir of configDirs) {
    const folder = path.join(dir, "projects", projectDirName(cwd))
    let names: string[]
    try { names = readdirSync(folder) } catch { continue }
    for (const name of names) if (name.endsWith(".jsonl")) add(name.slice(0, -6), path.join(folder, name))
  }
  const out: SessionCandidate[] = []
  for (const [id, { file, mtime }] of [...files].sort(([, a], [, b]) => b.mtime - a.mtime)) {
    if (cwdOf(file) && cwdOf(file) !== cwd) continue
    const messages = sessionMessages(file)
    const asks = outlineOf(messages)
    if (asks.length < SESSION_SOURCE_MIN_TURNS) continue
    out.push({ id, file, label: titleOf(file) ?? "", mtime, asks, outline: asks.map((line, i) => `${i + 1}. ${line}`).join("\n"), messages })
    if (out.length >= SESSION_SOURCE_CANDIDATES) break
  }
  return out
}

export function rankCandidates(prompt: string, candidates: SessionCandidate[]): SessionCandidate[] {
  const chunks: RecallChunk[] = candidates.map((c, i) => ({ turn: i, call: c.id, lines: [c.outline], terms: terms(c.outline) }))
  return rank(terms(prompt), chunks, SESSION_MIN_TERMS).map((r) => candidates[r.index])
}
