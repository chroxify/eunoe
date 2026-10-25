import path from "node:path"
import { type Config, claudeConfigDirs } from "../config"
import type { Message } from "../context/content"
import { splitTurns } from "../context/fold/turns"
import { recallChunks, warmIndex } from "../context/recall"
import { readSessionSlice } from "../transcript/entries"
import { findSessionFile, listEntries } from "../transcript/locate"
import { sessionMessages } from "../transcript/messages"
import { subagentChunks, subagentMessages, subagentRuns, subagentsDir } from "../transcript/subagents"
import { seenSessions } from "./sessions"

const SLICE_MS = 8
const SLICE_BYTES = 2 * 1024 * 1024
const RECENT_MS = 24 * 60 * 60 * 1000
const MAX_SESSIONS = 16
const TURNS_PER_SLICE = 40

let deadline = 0

async function breathe() {
  if (performance.now() < deadline) return
  await new Promise((resolve) => setTimeout(resolve, 1))
  deadline = performance.now() + SLICE_MS
}

const closingTurn: Message = { role: "user", content: "" }

async function warmSession(file: string) {
  while (!readSessionSlice(file, SLICE_BYTES)) await breathe()
  await breathe()
  for (const name of listEntries(subagentsDir(file))) {
    if (!name.endsWith(".jsonl")) continue
    while (!readSessionSlice(path.join(subagentsDir(file), name), SLICE_BYTES)) await breathe()
    await breathe()
  }
  const messages = sessionMessages(file)
  await breathe()
  const { preamble, turns } = splitTurns(messages)
  let end = preamble.length
  for (let i = 0; i < turns.length; i += 1) {
    end += turns[i].length
    if ((i + 1) % TURNS_PER_SLICE !== 0 && i !== turns.length - 1) continue
    recallChunks([...messages.slice(0, end), closingTurn], new Map())
    await breathe()
  }
  for (const run of subagentRuns(file)) {
    recallChunks([...subagentMessages(run), closingTurn], new Map())
    await breathe()
  }
  const corpus = [...recallChunks([...messages, closingTurn], new Map()), ...subagentChunks(file)]
  await breathe()
  while (!warmIndex(corpus, performance.now() + SLICE_MS)) await breathe()
}

export async function warmRecentSessions(config: Config, now = Date.now()) {
  deadline = performance.now() + SLICE_MS
  const recent = seenSessions()
    .filter(([, seen]) => seen.mode !== "off" && now - Date.parse(seen.lastSeen) < RECENT_MS)
    .slice(0, MAX_SESSIONS)
  for (const [id] of recent) {
    const file = findSessionFile(id, claudeConfigDirs(config))
    if (!file) continue
    try {
      await warmSession(file)
    } catch {}
    await breathe()
  }
}
