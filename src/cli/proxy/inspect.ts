import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { type Config, claudeConfigDirs } from "../../config"
import { paths } from "../../config/paths"
import { HEALTH_PATH, type Health } from "../../proxy/server"
import { parseJsonl } from "../../transcript/parse"
import { pointsAtEunoe, proxyUrl, readSettings } from "./claude-settings"

export interface RequestRecord {
  ts: string
  action?: string
  thread?: string | null
  input?: number
  charsIn?: number
  charsOut?: number
  charsFixed?: number
  cacheRead?: number
  cacheWrite?: number
  uncached?: number
  compacted?: boolean
  turns?: number
  reranked?: string
  rerankError?: string
  overflow?: number
  fit?: string
  [key: string]: unknown
}

export const RECENT_REQUESTS = 5_000

export async function probe(port: number): Promise<Health | null> {
  try {
    const response = await fetch(`${proxyUrl(port)}${HEALTH_PATH}`, { signal: AbortSignal.timeout(800) })
    if (!response.ok) return null
    return (await response.json()) as Health
  } catch {
    return null
  }
}

function newestSource(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestSource(file))
    else if (entry.name.endsWith(".ts")) newest = Math.max(newest, statSync(file).mtimeMs)
  }
  return newest
}

export function runsStaleCode(health: Health | null): boolean {
  if (!health?.startedAt) return health !== null
  try {
    return newestSource(path.join(import.meta.dir, "..")) > health.startedAt
  } catch {
    return false
  }
}

export function routedDirs(config: Config) {
  return claudeConfigDirs(config).filter((dir) => pointsAtEunoe(readSettings(dir), config.port))
}

export function recentRequests(limit = RECENT_REQUESTS): RequestRecord[] {
  if (!existsSync(paths.requests)) return []
  return parseJsonl<RequestRecord>(readFileSync(paths.requests, "utf8")).slice(-limit)
}
