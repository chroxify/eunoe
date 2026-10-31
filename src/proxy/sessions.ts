import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs"
import { EUNOE_DIR, paths } from "../config/paths"
import type { Mode } from "../core/config"

interface SeenSession {
  lastSeen: string
  mode: Mode
  cwd?: string
}

const HEAD_BYTES = 65_536

let seen: Record<string, SeenSession> | null = null

function readSeen(): Record<string, SeenSession> {
  try {
    return JSON.parse(readFileSync(paths.sessions, "utf8"))
  } catch {
    return {}
  }
}

const newestFirst = (entries: Array<[string, SeenSession]>) => entries.sort(([, a], [, b]) => b.lastSeen.localeCompare(a.lastSeen))

export function cwdOf(sessionFile: string): string | undefined {
  try {
    const fd = openSync(sessionFile, "r")
    const buffer = Buffer.alloc(HEAD_BYTES)
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0)
    closeSync(fd)
    return buffer
      .subarray(0, read)
      .toString("utf8")
      .match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1]
  } catch {
    return undefined
  }
}

export function titleOf(sessionFile: string): string | undefined {
  try {
    return readFileSync(sessionFile, "utf8").match(/"aiTitle":"((?:[^"\\]|\\.)*)"/)?.[1]
  } catch {
    return undefined
  }
}

export function recordSession(sessionId: string, mode: Mode, sessionFile: string | null) {
  seen ??= readSeen()
  const previous = seen[sessionId]
  const now = Date.now()
  const needsCwd = !previous?.cwd && sessionFile !== null
  if (previous && previous.mode === mode && !needsCwd && now - Date.parse(previous.lastSeen) < 30_000) return
  seen[sessionId] = { lastSeen: new Date(now).toISOString(), mode, cwd: previous?.cwd ?? (sessionFile ? cwdOf(sessionFile) : undefined) }
  seen = Object.fromEntries(newestFirst(Object.entries(seen)).slice(0, 200))
  try {
    mkdirSync(EUNOE_DIR, { recursive: true })
    writeFileSync(paths.sessions, JSON.stringify(seen, null, 2))
  } catch {}
}

export function seenSessions(): Array<[string, SeenSession]> {
  return newestFirst(Object.entries(readSeen()))
}
