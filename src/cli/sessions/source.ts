import { readdirSync, statSync } from "node:fs"
import path from "node:path"
import { textOf } from "../../context/content"
import { isPrompt, splitTurns } from "../../context/fold/turns"
import { rank, terms } from "../../context/recall"
import type { RecallChunk } from "../../context/recall/types"
import type { Message } from "../../context/types"
import { cwdOf, seenSessions, titleOf } from "../../proxy/sessions"
import { findSessionFile } from "../../transcript/locate"
import { sessionMessages } from "../../transcript/messages"
import { INJECTED_TAGS, SESSION_MIN_TERMS, SESSION_OUTLINE_CHARS, SESSION_SOURCE_CANDIDATES, SESSION_SOURCE_MIN_TURNS } from "./constants"
import type { SessionCandidate } from "./types"

const promptText = (message: Message) => textOf(message).replace(INJECTED_TAGS, "").trim()

export function outlineOf(messages: Message[]): string[] {
  const { turns } = splitTurns(messages)
  return turns
    .filter((turn) => isPrompt(turn[0]))
    .map((turn) => promptText(turn[0]))
    .filter(Boolean)
    .map((text) => text.slice(0, SESSION_OUTLINE_CHARS))
}

const projectDirName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-")

export function sessionCandidates(sessionId: string, cwd: string, configDirs: string[]): SessionCandidate[] {
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
    const folder = path.join(dir, "projects", projectDirName(cwd))
    let names: string[]
    try {
      names = readdirSync(folder)
    } catch {
      continue
    }
    for (const name of names) if (name.endsWith(".jsonl")) add(name.slice(0, -6), path.join(folder, name))
  }
  const out: SessionCandidate[] = []
  for (const [id, { file, mtime }] of [...files].sort(([, a], [, b]) => b.mtime - a.mtime)) {
    const recorded = cwdOf(file)
    if (recorded && recorded !== cwd) continue
    const messages = sessionMessages(file)
    const asks = outlineOf(messages)
    if (asks.length < SESSION_SOURCE_MIN_TURNS) continue
    out.push({ id, file, label: titleOf(file) ?? "", mtime, asks, outline: asks.map((line, i) => `${i + 1}. ${line}`).join("\n"), messages })
    if (out.length >= SESSION_SOURCE_CANDIDATES) break
  }
  return out
}

export function rankCandidates(prompt: string, candidates: SessionCandidate[]): SessionCandidate[] {
  const chunks: RecallChunk[] = candidates.map((cand, i) => ({ turn: i, call: cand.id, lines: [cand.outline], terms: terms(cand.outline) }))
  return rank(terms(prompt), chunks, SESSION_MIN_TERMS).map((r) => candidates[r.index])
}
