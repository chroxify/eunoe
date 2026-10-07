import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { claudeConfigDirs } from "../config"
import { paths } from "../config/constants"
import type { Config } from "../config/types"
import { HEALTH_PATH } from "../proxy/constants"
import type { Health } from "../proxy/types"
import { proxyUrl } from "./claude-settings"
import { PROBE_TIMEOUT_MS, RECENT_REQUESTS } from "./constants"
import type { RequestRecord } from "./types"

export async function probe(port: number): Promise<Health | null> {
  try {
    const response = await fetch(`${proxyUrl(port)}${HEALTH_PATH}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return response.ok ? await response.json() as Health : null
  } catch {
    return null
  }
}

export function routedDirs(config: Config) {
  return claudeConfigDirs(config).filter((dir) => {
    try {
      const settings = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"))
      return settings.env?.ANTHROPIC_BASE_URL === proxyUrl(config.port)
    } catch {
      return false
    }
  })
}

export function recentRequests(limit = RECENT_REQUESTS): RequestRecord[] {
  if (!existsSync(paths.requests)) return []
  return readFileSync(paths.requests, "utf8").trim().split("\n").slice(-limit).flatMap((entry) => {
    try {
      return [JSON.parse(entry)]
    } catch {
      return []
    }
  })
}
