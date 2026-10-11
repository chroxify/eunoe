import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { SESSION_ID_PATTERN } from "../config/constants"

const found = new Map<string, string>()

export function findSessionByPrefix(prefix: string, configDirs: string[], exclude?: string): string | null {
  if (!SESSION_ID_PATTERN.test(prefix)) return null
  const hits = new Map<string, string>()
  for (const configDir of configDirs) {
    const projects = path.join(configDir, "projects")
    let dirs: string[]
    try {
      dirs = readdirSync(projects)
    } catch {
      continue
    }
    for (const dir of dirs) {
      let names: string[]
      try {
        names = readdirSync(path.join(projects, dir))
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl") || !name.startsWith(prefix)) continue
        const id = name.slice(0, -6)
        if (id !== exclude && !hits.has(id)) hits.set(id, path.join(projects, dir, name))
      }
    }
  }
  return hits.size === 1 ? [...hits.values()][0] : null
}

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
