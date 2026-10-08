/**
 * The Claude Code CLI as the benchmark drives it: one pinned account, hooks
 * off, MCP off, prompts through files, infrastructure failures retried.
 *
 * Every call runs on the account in BENCH_CLAUDE_CONFIG_DIR so the live login
 * is never touched. When that account has been rate-limited for
 * CREDITS_AFTER_MS, calls move to an API key (~/.config/eunoe-bench/api-key)
 * for CREDITS_FOR_MS, then return to the account.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const OUT = path.join(import.meta.dir, "..", "out")
export const CONFIG_DIR = process.env.BENCH_CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude")
export const UPSTREAM = "https://api.anthropic.com"
const API_KEY_FILE = path.join(homedir(), ".config", "eunoe-bench", "api-key")
export const API_KEY = existsSync(API_KEY_FILE) ? readFileSync(API_KEY_FILE, "utf8").trim() : ""
const CREDITS_AFTER_MS = 30 * 60_000
const CREDITS_FOR_MS = 60 * 60_000

// Hooks are the user's (phone pings on every finished turn); every call here is scripted.
export const BASE_SETTINGS = { disableAllHooks: true, env: { ANTHROPIC_BASE_URL: UPSTREAM } }
export const NO_TOOLS = ["--settings", JSON.stringify(BASE_SETTINGS), "--disallowedTools", "Bash Read Edit Write Glob Grep WebFetch WebSearch Agent"]
export const READ_ONLY = "Read Grep Glob Bash(grep:*) Bash(rg:*) Bash(jq:*) Bash(head:*) Bash(tail:*) Bash(sed:*) Bash(wc:*) Bash(cat:*) Bash(awk:*) Bash(ls:*) Bash(qmd:*) Bash(cd:*)"

/** Claude Code's project directory for a working directory, under the pinned account. */
export const projectDir = (cwd: string) => path.join(CONFIG_DIR, "projects", realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-"))

const LIMIT_ERROR = /^\s*(?:You(?:'ve)? (?:hit|reached) your (?:\w+ )?limit|Claude usage limit reached|API Error: (?:429|529)|\S*(?:rate_limit_error|overloaded_error))/i
const LOST_PROMPT = /no stdin data received|Provide a prompt to continue/i
const isLimit = (result: string) => result.length < 400 && LIMIT_ERROR.test(result)
// Both patterns can be quoted inside a real answer (sessions about this very
// benchmark do), so only a short result counts as the failure itself.
const retryable = (result: string) => isLimit(result) || (result.length < 400 && LOST_PROMPT.test(result))

// Account state shared by every call: when the subscription has been limited
// for a while, everything moves to API credits for a window, then comes back.
let limitedSince: number | null = null
let creditsUntil = 0
const onCredits = () => Boolean(API_KEY) && Date.now() < creditsUntil
const authEnv = (): Record<string, string> => (onCredits() ? { ANTHROPIC_API_KEY: API_KEY } : {})

export async function claudeOnce(args: string[], o: { cwd: string; env?: Record<string, string>; stdin: string }) {
  const started = Date.now()
  // The prompt goes through a real file: the CLI abandons stdin after 3s and
  // runs promptless, which a pipe can lose under heavy concurrency.
  const promptFile = path.join(OUT, "prompts", `${crypto.randomUUID()}.txt`)
  mkdirSync(path.dirname(promptFile), { recursive: true })
  writeFileSync(promptFile, o.stdin)
  const credits = onCredits()
  const proc = Bun.spawn(["claude", "-p", "--output-format", "json", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', ...args], {
    cwd: o.cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR, ...authEnv(), ...o.env }, stdin: Bun.file(promptFile), stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), 25 * 60_000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  clearTimeout(timer)
  await proc.exited
  rmSync(promptFile, { force: true })
  let json: any
  try { json = JSON.parse(stdout) } catch { json = { is_error: true, result: `${stdout.slice(0, 300)} ${stderr.slice(0, 300)}` } }
  if (!isLimit(String(json.result ?? "")) && !credits) limitedSince = null
  return { ...json, wallMs: Date.now() - started, credits }
}

/**
 * Retry anything that is an infrastructure failure rather than a bad answer.
 * `args` may be a function so each attempt can start from a fresh session copy.
 */
export async function claude(args: string[] | (() => string[]), o: { cwd: string; env?: Record<string, string>; stdin: string }): Promise<any> {
  for (let attempt = 0; ; attempt += 1) {
    const out = await claudeOnce(typeof args === "function" ? args() : args, o)
    const result = String(out.result ?? "")
    if (!retryable(result) || attempt >= 40) return out
    let wait = 5_000
    if (isLimit(result)) {
      if (out.credits) {
        wait = 60_000
      } else {
        limitedSince ??= Date.now()
        if (API_KEY && Date.now() - limitedSince >= CREDITS_AFTER_MS) {
          creditsUntil = Date.now() + CREDITS_FOR_MS
          limitedSince = null
          console.log(`  subscription limited for ${Math.round(CREDITS_AFTER_MS / 60_000)}m; using API credits until ${new Date(creditsUntil).toLocaleTimeString()}`)
          continue
        }
        wait = 10 * 60_000
      }
    }
    console.log(`  retrying in ${Math.round(wait / 1000)}s: ${result.slice(0, 80)}`)
    await Bun.sleep(wait)
  }
}
