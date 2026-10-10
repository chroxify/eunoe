import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const OUT = path.join(import.meta.dir, "..", "out")
export const CONFIG_DIR = process.env.BENCH_CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude")
export const ALL_CONFIG_DIRS = [...new Set([CONFIG_DIR, path.join(homedir(), ".claude"), ...(existsSync(path.join(homedir(), ".claude-swap-backup", "sessions")) ? readdirSync(path.join(homedir(), ".claude-swap-backup", "sessions")).map((d) => path.join(homedir(), ".claude-swap-backup", "sessions", d)) : [])])]

export const PLANTED_OUT = path.join(import.meta.dir, "..", "out", "planted")
export const COMPONENTS = path.join(import.meta.dir, "..", "out", "evals")
export const REAL_OUT = path.join(import.meta.dir, "..", "out", "real")

export const UPSTREAM = "https://api.anthropic.com"
export const API_KEY_FILE = path.join(homedir(), ".config", "eunoe-bench", "api-key")
export const API_KEY = existsSync(API_KEY_FILE) ? readFileSync(API_KEY_FILE, "utf8").trim() : ""
export const BASE_SETTINGS = { disableAllHooks: true, env: { ANTHROPIC_BASE_URL: UPSTREAM } }
export const NO_TOOLS = ["--settings", JSON.stringify(BASE_SETTINGS), "--disallowedTools", "Bash Read Edit Write Glob Grep WebFetch WebSearch Agent"]
export const READ_ONLY = "Read Grep Glob Bash(grep:*) Bash(rg:*) Bash(jq:*) Bash(head:*) Bash(tail:*) Bash(sed:*) Bash(wc:*) Bash(cat:*) Bash(awk:*) Bash(ls:*) Bash(qmd:*) Bash(cd:*)"

export const CSWAP_ACCOUNT = process.env.BENCH_CSWAP_ACCOUNT ?? "3"
export const ROTATE: string[] = (process.env.BENCH_CSWAP_ROTATE ?? "").split(",").filter(Boolean)
export const LIMIT_HOLD_MS = 10 * 60_000
export const CREDITS_AFTER_MS = 30 * 60_000
export const CREDITS_FOR_MS = 60 * 60_000

export const LIMIT_ERROR = /^\s*(?:You(?:'ve)? (?:hit|reached) your (?:\w+ )?limit|Claude usage limit reached|API Error: (?:429|529)|\S*(?:rate_limit_error|overloaded_error))/i
export const LOST_PROMPT = /no stdin data received|Provide a prompt to continue/i
export const AUTH_ERROR = /Failed to authenticate|OAuth|not logged in|Invalid authentication|authentication_error/i

export const TOOL_FACTS = new Set(["tool_value", "error", "superseded", "prose_value"])

export const JEV_KEY_FILE = path.join(homedir(), ".config", "eunoe-bench", "typesafe-key")
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
export const JEV_BLOCK = 255
export const JEV_MAX_LINES = 1_000

export const EVIDENCE_CATEGORIES: Array<[string, string, string]> = [
  ["error", "This output contains an error, failure, exception or warning line", "Which line is the main error, failure or warning message?"],
  ["status", "This output contains a final status or result line, such as deployed to, N passed, N failed, exit code, done, created, published", "Which line states the final status or result of the command?"],
  ["ident", "This output prints an identifier a developer may need to recall later: an id, hash, URL, version number, token, key, host or resource name", "Which line prints the most important identifier (id, hash, URL, version, name)?"],
  ["measure", "This output prints a measurement, count or amount: a duration, size, row count, test count, price or percentage", "Which line prints the most important measurement, count or amount?"],
  ["change", "This output names a file, path, migration, table, branch or resource that was created, changed, applied or deleted", "Which line names what was created, changed, applied or deleted?"],
]

export const TYPESAFE_KEY_FILE = path.join(homedir(), ".eunoe", "typesafe-key")
