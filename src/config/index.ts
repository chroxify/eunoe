import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { DEFAULTS, EUNOE_DIR, MODES, paths, SCOPES, SEARCH_MODES, TUNABLES } from "./constants"
import type { Config, Mode, SessionSettings, Tunable, Tunables } from "./types"

const VALID: { [K in Tunable]: (value: unknown) => value is Tunables[K] } = {
  compactAt: (value): value is number => typeof value === "number" && value > 0 && value <= 1,
  keepTurns: (value): value is number | "all" => value === "all" || (Number.isInteger(value) && (value as number) >= 0),
  search: (value): value is Tunables["search"] => SEARCH_MODES.includes(value as Tunables["search"]),
}

const isMode = (value: unknown): value is Mode => MODES.includes(value as Mode)

export function parseTunable<K extends Tunable>(key: K, raw: string): Tunables[K] | null {
  const value = key === "search" || raw === "all" ? raw : Number(raw)
  return VALID[key](value) ? value as Tunables[K] : null
}

function normalizeSession(value: unknown): SessionSettings | null {
  if (value === null) return {}
  if (isMode(value)) return { mode: value }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const settings: SessionSettings = isMode(raw.mode) ? { mode: raw.mode } : {}
  for (const key of TUNABLES) if (VALID[key](raw[key])) Object.assign(settings, { [key]: raw[key] })
  return settings
}

export function normalizeConfig(raw: Record<string, any>): Config {
  const config: Config = { ...DEFAULTS, ...raw }
  if (!isMode(config.mode)) config.mode = DEFAULTS.mode
  if (!SCOPES.includes(config.scope)) config.scope = DEFAULTS.scope
  for (const key of TUNABLES) if (!VALID[key](config[key])) Object.assign(config, { [key]: DEFAULTS[key] })
  const sessions = config.sessions && typeof config.sessions === "object" && !Array.isArray(config.sessions) ? config.sessions : {}
  config.sessions = Object.fromEntries(Object.entries(sessions).flatMap(([id, value]) => {
    const settings = normalizeSession(value)
    return settings ? [[id, settings]] : []
  }))
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

export function modeFor(config: Config, sessionId: string | null): Mode {
  if (sessionId && sessionId in config.sessions) return config.sessions[sessionId].mode ?? config.mode
  return config.scope === "all" ? config.mode : "off"
}

export function overrides(settings: SessionSettings | undefined): Partial<Tunables> {
  return Object.fromEntries(TUNABLES.filter((key) => settings?.[key] !== undefined).map((key) => [key, settings![key]]))
}

export function settingsFor(config: Config, sessionId: string | null): Config {
  return { ...config, ...overrides(sessionId ? config.sessions[sessionId] : undefined), mode: modeFor(config, sessionId) }
}

export function compactionOwner(config: Config): Mode {
  return config.scope === "all" ? config.mode : "off"
}
