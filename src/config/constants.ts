import { homedir } from "node:os"
import path from "node:path"
import type { Config, Mode, SearchMode } from "./types"

export const EUNOE_DIR = process.env.EUNOE_DIR ?? path.join(homedir(), ".eunoe")

export const paths = {
  config: path.join(EUNOE_DIR, "config.json"),
  requests: path.join(EUNOE_DIR, "requests.jsonl"),
  threads: path.join(EUNOE_DIR, "threads"),
  transcripts: path.join(EUNOE_DIR, "transcripts"),
  models: path.join(EUNOE_DIR, "models.json"),
  proxyLog: path.join(EUNOE_DIR, "proxy.log"),
}

export const DEFAULTS: Config = {
  mode: "compact",
  port: 8788,
  compactAt: 0.9,
  keepTurns: "all",
  search: "markdown",
  upstream: "https://api.anthropic.com",
  claudeConfigDirs: [],
}

export const MODES: Mode[] = ["off", "trim", "compact"]
export const SEARCH_MODES: SearchMode[] = ["jsonl", "markdown", "xml", "qmd"]
