import { homedir } from "node:os"
import path from "node:path"
import type { Config, Mode, Scope, SearchMode, Tunable } from "./types"

export const EUNOE_DIR = process.env.EUNOE_DIR ?? path.join(homedir(), ".eunoe")

export const paths = {
  config: path.join(EUNOE_DIR, "config.json"),
  requests: path.join(EUNOE_DIR, "requests.jsonl"),
  threads: path.join(EUNOE_DIR, "threads"),
  transcripts: path.join(EUNOE_DIR, "transcripts"),
  models: path.join(EUNOE_DIR, "models.json"),
  sessions: path.join(EUNOE_DIR, "sessions.json"),
  proxyLog: path.join(EUNOE_DIR, "proxy.log"),
  typesafeKey: path.join(EUNOE_DIR, "typesafe-key"),
}

export const RERANK_OFF = "off"

export const DEFAULTS: Config = {
  mode: "default",
  scope: "all",
  sessions: {},
  port: 8788,
  compactAt: 0.9,
  keepTurns: "all",
  keep: 3,
  budget: 100_000,
  search: "markdown",
  rerank: "jev-preview",
  upstream: "https://api.anthropic.com",
  claudeConfigDirs: [],
}

export const MODES: Mode[] = ["default", "compact", "off"]
export const SEARCH_MODES: SearchMode[] = ["jsonl", "markdown", "xml", "qmd"]
export const TUNABLES: Tunable[] = ["keep", "budget", "compactAt", "keepTurns", "search", "rerank"]
export const SCOPES: Scope[] = ["all", "sessions"]
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9-]+$/
