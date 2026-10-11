import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { claudeConfigDirs } from "../../config"
import { paths } from "../../config/constants"
import type { Config } from "../../config/types"
import { HEALTH_PATH } from "../../proxy/constants"
import type { Health } from "../../proxy/types"
import { parseJsonl } from "../../transcript/parse"
import { proxyUrl } from "./claude-settings"
import { PROBE_TIMEOUT_MS, RECENT_REQUESTS } from "./constants"
import type { RequestRecord, Settings } from "./types"

export async function probe(port: number): Promise<Health | null> {
  try {
    const response = await fetch(`${proxyUrl(port)}${HEALTH_PATH}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
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

export function readSettings(dir: string): Settings {
  try {
    return JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"))
  } catch {
    return {}
  }
}

export function routedDirs(config: Config) {
  return claudeConfigDirs(config).filter((dir) => readSettings(dir).env?.ANTHROPIC_BASE_URL === proxyUrl(config.port))
}

export function recentRequests(limit = RECENT_REQUESTS): RequestRecord[] {
  if (!existsSync(paths.requests)) return []
  return parseJsonl<RequestRecord>(readFileSync(paths.requests, "utf8")).slice(-limit)
}
