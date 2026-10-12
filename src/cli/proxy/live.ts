import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

export interface LiveSession {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  status: string
  entrypoint: string
}

const isLiveSession = (value: Partial<LiveSession>): value is LiveSession => typeof value.pid === "number" && typeof value.sessionId === "string" && typeof value.startedAt === "number" && typeof value.status === "string"

function runsClaude(pid: number) {
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
  return result.status === 0 && /claude/i.test(result.stdout)
}

export function listLiveSessions(configDirs: string[]): LiveSession[] {
  const live: LiveSession[] = []
  for (const dir of configDirs) {
    const sessionsDir = path.join(dir, "sessions")
    if (!existsSync(sessionsDir)) continue
    for (const file of readdirSync(sessionsDir).filter((name) => /^\d+\.json$/.test(name))) {
      try {
        const session = JSON.parse(readFileSync(path.join(sessionsDir, file), "utf8"))
        if (isLiveSession(session) && runsClaude(session.pid)) live.push(session)
      } catch {}
    }
  }
  return live
}

export function unroutedSessions(live: LiveSession[], lastSeen: Map<string, string>, managed: (sessionId: string) => boolean, self: string | undefined): LiveSession[] {
  return live.filter((session) => {
    if (session.sessionId === self || !managed(session.sessionId)) return false
    const seen = lastSeen.get(session.sessionId)
    return !seen || Date.parse(seen) < session.startedAt
  })
}

export const isIdle = (session: LiveSession) => session.status === "idle"

export const isTerminal = (session: LiveSession) => session.entrypoint === "cli"

export function restartSessions(sessions: LiveSession[]): LiveSession[] {
  return sessions.filter((session) => {
    try {
      process.kill(session.pid, "SIGTERM")
      return true
    } catch {
      return false
    }
  })
}
