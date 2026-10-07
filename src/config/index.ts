import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { DEFAULTS, EUNOE_DIR, MODES, paths, SEARCH_MODES } from "./constants"
import type { Config } from "./types"

export function normalizeConfig(raw: Record<string, any>): Config {
  const config: Config = { ...DEFAULTS, ...raw }
  if (!MODES.includes(config.mode)) config.mode = DEFAULTS.mode
  if (!SEARCH_MODES.includes(config.search)) config.search = DEFAULTS.search
  if (typeof config.compactAt !== "number" || config.compactAt <= 0 || config.compactAt > 1) config.compactAt = DEFAULTS.compactAt
  if (config.keepTurns !== "all" && (typeof config.keepTurns !== "number" || config.keepTurns < 0)) config.keepTurns = DEFAULTS.keepTurns
  if (!Number.isInteger(config.port)) config.port = DEFAULTS.port
  if (!Array.isArray(config.claudeConfigDirs)) config.claudeConfigDirs = []
  return config
}

let cached: { mtimeMs: number; config: Config } | null = null

export function loadConfig(): Config {
  let mtimeMs: number
  try {
    mtimeMs = statSync(paths.config).mtimeMs
  } catch {
    return DEFAULTS
  }
  if (cached?.mtimeMs === mtimeMs) return cached.config
  let config = DEFAULTS
  try {
    config = normalizeConfig(JSON.parse(readFileSync(paths.config, "utf8")))
  } catch (error) {
    console.error(`[eunoe] ${paths.config} is not valid JSON; using defaults`, error)
  }
  cached = { mtimeMs, config }
  return config
}

export function saveConfig(patch: Partial<Config>) {
  mkdirSync(EUNOE_DIR, { recursive: true })
  const current = existsSync(paths.config) ? JSON.parse(readFileSync(paths.config, "utf8")) : {}
  writeFileSync(paths.config, JSON.stringify({ ...current, ...patch }, null, 2) + "\n")
}

export function claudeConfigDirs(config: Config): string[] {
  const dirs = new Set([path.join(homedir(), ".claude")])
  if (process.env.CLAUDE_CONFIG_DIR) dirs.add(process.env.CLAUDE_CONFIG_DIR)
  for (const dir of config.claudeConfigDirs) dirs.add(dir.replace(/^~(?=$|\/)/, homedir()))
  return [...dirs]
}
