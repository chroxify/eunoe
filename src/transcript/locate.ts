import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { SESSION_ID_PATTERN } from "../config/constants"

const found = new Map<string, string>()

export function findSessionFile(sessionId: string, configDirs: string[]): string | null {
  const hit = found.get(sessionId)
  if (hit && existsSync(hit)) return hit
  if (!SESSION_ID_PATTERN.test(sessionId)) return null
  for (const configDir of configDirs) {
    const projects = path.join(configDir, "projects")
    let dirs: string[]
    try {
      dirs = readdirSync(projects)
    } catch {
      continue
    }
    for (const dir of dirs) {
      const file = path.join(projects, dir, `${sessionId}.jsonl`)
      if (existsSync(file)) {
        found.set(sessionId, file)
        return file
      }
    }
  }
  return null
}
