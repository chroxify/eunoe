import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { CORE_DEFAULTS, type CoreConfig, type Mode } from "../core/config"
import { EUNOE_DIR, paths } from "./paths"

export type SearchMode = "jsonl" | "markdown" | "xml" | "qmd"
type Scope = "all" | "sessions"

export interface Tunables extends Pick<CoreConfig, "compactAt" | "keepTurns" | "keep" | "budget" | "turnCap"> {
  search: SearchMode
  rerank: string
}

export type Tunable = keyof Tunables

interface SessionSettings extends Partial<Tunables> {
  mode?: Mode
}

export interface Config extends CoreConfig, Tunables {
  scope: Scope
  sessions: Record<string, SessionSettings>
  port: number
  upstream: string
  claudeConfigDirs: string[]
  window?: number
}

export const DEFAULTS: Config = {
  ...CORE_DEFAULTS,
  scope: "all",
  sessions: {},
  port: 38663,
  search: "markdown",
  rerank: "jev-preview",
  upstream: "https://api.anthropic.com",
  claudeConfigDirs: [],
}

export const MODES: Mode[] = ["default", "compact", "off"]
export const TUNABLES: Tunable[] = ["keep", "budget", "turnCap", "compactAt", "keepTurns", "search", "rerank"]

const SEARCH_MODES: SearchMode[] = ["jsonl", "markdown", "xml", "qmd"]
const TEXT_TUNABLES: Tunable[] = ["search", "rerank"]

const isWhole = (value: unknown, min: number): value is number => Number.isInteger(value) && (value as number) >= min

const validators: { [K in Tunable]: (value: unknown) => value is Tunables[K] } = {
  compactAt: (value): value is number => typeof value === "number" && value > 0 && value <= 1,
  keepTurns: (value): value is number | "all" => value === "all" || isWhole(value, 0),
  keep: (value): value is number => isWhole(value, 1),
  budget: (value): value is number => isWhole(value, 1_000),
  turnCap: (value): value is number | "off" => value === "off" || isWhole(value, 1_000),
  search: (value): value is SearchMode => SEARCH_MODES.includes(value as SearchMode),
  rerank: (value): value is string => typeof value === "string" && /^[\w.-]+$/.test(value),
}

const isMode = (value: unknown): value is Mode => MODES.includes(value as Mode)

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)

export function parseTunable<K extends Tunable>(key: K, raw: string): Tunables[K] | null {
  const value = TEXT_TUNABLES.includes(key) || raw === "all" || raw === "off" ? raw : Number(raw.replace(/[_,]/g, ""))
  return validators[key](value) ? (value as Tunables[K]) : null
}

function normalizeSession(value: unknown): SessionSettings | null {
  if (value === null) return {}
  if (isMode(value)) return { mode: value }
  if (!isRecord(value)) return null
  const settings: SessionSettings = isMode(value.mode) ? { mode: value.mode } : {}
  for (const key of TUNABLES) if (validators[key](value[key])) Object.assign(settings, { [key]: value[key] })
  return settings
}

export function normalizeConfig(raw: Record<string, unknown>): Config {
  const config = { ...DEFAULTS, ...raw } as Config
  if (!isMode(config.mode)) config.mode = DEFAULTS.mode
  if (config.scope !== "all" && config.scope !== "sessions") config.scope = DEFAULTS.scope
  for (const key of TUNABLES) if (!validators[key](config[key])) Object.assign(config, { [key]: DEFAULTS[key] })
  const sessions = isRecord(config.sessions) ? config.sessions : {}
  config.sessions = Object.fromEntries(
    Object.entries(sessions).flatMap(([id, value]) => {
      const settings = normalizeSession(value)
      return settings ? [[id, settings]] : []
    }),
  )
  if (!Number.isInteger(config.port)) config.port = DEFAULTS.port
  if (!Array.isArray(config.claudeConfigDirs)) config.claudeConfigDirs = []
  return config
}

let cached: { mtimeMs: number; config: Config } | null = null

export function readConfig(): Config {
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
  } catch {}
  cached = { mtimeMs, config }
  return config
}

export function saveConfig(patch: Partial<Config>) {
  mkdirSync(EUNOE_DIR, { recursive: true })
  const current = existsSync(paths.config) ? JSON.parse(readFileSync(paths.config, "utf8")) : {}
  writeFileSync(paths.config, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`)
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

export function compactionOwner(config: Config): Mode {
  return modeFor(config, null)
}

export function overrides(settings: SessionSettings | undefined): Partial<Tunables> {
  return Object.fromEntries(TUNABLES.filter((key) => settings?.[key] !== undefined).map((key) => [key, settings?.[key]]))
}

export function settingsFor(config: Config, sessionId: string | null): Config {
  return { ...config, ...overrides(sessionId ? config.sessions[sessionId] : undefined), mode: modeFor(config, sessionId) }
}
