import { existsSync, readdirSync } from "node:fs"
import path from "node:path"

const found = new Map<string, string>()

export const isSessionId = (value: string) => /^[a-zA-Z0-9-]+$/.test(value)

export const projectFolderName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-")

export function listEntries(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function projectFolders(configDirs: string[]): string[] {
  return configDirs.flatMap((configDir) => {
    const projects = path.join(configDir, "projects")
    return listEntries(projects).map((name) => path.join(projects, name))
  })
}

export function findSessionByPrefix(prefix: string, configDirs: string[], exclude?: string): string | null {
  if (!isSessionId(prefix)) return null
  const hits = new Map<string, string>()
  for (const folder of projectFolders(configDirs)) {
    for (const name of listEntries(folder)) {
      if (!name.endsWith(".jsonl") || !name.startsWith(prefix)) continue
      const id = name.slice(0, -".jsonl".length)
      if (id !== exclude && !hits.has(id)) hits.set(id, path.join(folder, name))
    }
  }
  return hits.size === 1 ? [...hits.values()][0] : null
}

export function findSessionFile(sessionId: string, configDirs: string[]): string | null {
  const hit = found.get(sessionId)
  if (hit && existsSync(hit)) return hit
  if (!isSessionId(sessionId)) return null
  for (const folder of projectFolders(configDirs)) {
    const file = path.join(folder, `${sessionId}.jsonl`)
    if (!existsSync(file)) continue
    found.set(sessionId, file)
    return file
  }
  return null
}
