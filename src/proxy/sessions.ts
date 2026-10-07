import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs"
import { EUNOE_DIR, paths } from "../config/constants"
import type { Mode } from "../config/types"
import { SESSION_HEAD_BYTES, SESSION_SEEN_INTERVAL_MS, SESSIONS_KEPT } from "./constants"
import type { SeenSession } from "./types"

let seen: Record<string, SeenSession> | null = null

function load(): Record<string, SeenSession> {
  try {
    return JSON.parse(readFileSync(paths.sessions, "utf8"))
  } catch {
    return {}
  }
}

function cwdOf(sessionFile: string): string | undefined {
  try {
    const fd = openSync(sessionFile, "r")
    const buffer = Buffer.alloc(SESSION_HEAD_BYTES)
    const read = readSync(fd, buffer, 0, SESSION_HEAD_BYTES, 0)
    closeSync(fd)
    return buffer.subarray(0, read).toString("utf8").match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1]
  } catch {
    return undefined
  }
}

export function recordSession(sessionId: string, mode: Mode, sessionFile: string | null) {
  seen ??= load()
  const previous = seen[sessionId]
  const now = Date.now()
  const needsCwd = !previous?.cwd && sessionFile !== null
  if (previous && previous.mode === mode && !needsCwd && now - Date.parse(previous.lastSeen) < SESSION_SEEN_INTERVAL_MS) return
  seen[sessionId] = { lastSeen: new Date(now).toISOString(), mode, cwd: previous?.cwd ?? (sessionFile ? cwdOf(sessionFile) : undefined) }
  const kept = Object.entries(seen).sort(([, a], [, b]) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, SESSIONS_KEPT)
  seen = Object.fromEntries(kept)
  try {
    mkdirSync(EUNOE_DIR, { recursive: true })
    writeFileSync(paths.sessions, JSON.stringify(seen, null, 2))
  } catch {}
}

export function seenSessions(): Array<[string, SeenSession]> {
  return Object.entries(load()).sort(([, a], [, b]) => b.lastSeen.localeCompare(a.lastSeen))
}
