import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const OUT = path.join(import.meta.dir, "..", "out")

export const CONFIG_DIR = process.env.BENCH_CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude")

export const UPSTREAM = "https://api.anthropic.com"

export const API_KEY_FILE = path.join(homedir(), ".config", "eunoe-bench", "api-key")

export const API_KEY = existsSync(API_KEY_FILE) ? readFileSync(API_KEY_FILE, "utf8").trim() : ""

export const BASE_SETTINGS = { disableAllHooks: true, env: { ANTHROPIC_BASE_URL: UPSTREAM } }

export const NO_TOOLS = ["--settings", JSON.stringify(BASE_SETTINGS), "--disallowedTools", "Bash Read Edit Write Glob Grep WebFetch WebSearch Agent"]

export const READ_ONLY = "Read Grep Glob Bash(grep:*) Bash(rg:*) Bash(jq:*) Bash(head:*) Bash(tail:*) Bash(sed:*) Bash(wc:*) Bash(cat:*) Bash(awk:*) Bash(ls:*) Bash(qmd:*) Bash(cd:*)"

const CSWAP_ACCOUNT = process.env.BENCH_CSWAP_ACCOUNT ?? "3"

const ROTATE: string[] = (process.env.BENCH_CSWAP_ROTATE ?? "").split(",").filter(Boolean)

const LIMIT_HOLD_MS = 10 * 60_000

const CREDITS_AFTER_MS = 30 * 60_000

const CREDITS_FOR_MS = 60 * 60_000

const LIMIT_ERROR = /^\s*(?:You(?:'ve)? (?:hit|reached) your (?:\w+ )?limit|Claude usage limit reached|API Error: (?:429|529)|\S*(?:rate_limit_error|overloaded_error))/i

const LOST_PROMPT = /no stdin data received|Provide a prompt to continue/i

const AUTH_ERROR = /Failed to authenticate|OAuth|not logged in|Invalid authentication|authentication_error/i

export const projectDir = (cwd: string) => path.join(CONFIG_DIR, "projects", realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-"))

const isAuth = (result: string) => result.length < 400 && AUTH_ERROR.test(result)
const limitedUntil = new Map<string, number>()
export function chooseAccount(): string {
  const now = Date.now()
  if ((limitedUntil.get(CSWAP_ACCOUNT) ?? 0) <= now) return CSWAP_ACCOUNT
  for (const n of ROTATE) if (n !== CSWAP_ACCOUNT && (limitedUntil.get(n) ?? 0) <= now) return n
  return CSWAP_ACCOUNT
}
export class AccountLimited extends Error {}

async function refreshLogin() {
  const proc = Bun.spawn(["cswap", "run", CSWAP_ACCOUNT, "--", "--model", "claude-haiku-4-5-20251001", "-p", "ok"], { stdout: "pipe", stderr: "pipe" })
  await proc.exited
}
const isLimit = (result: string) => result.length < 400 && LIMIT_ERROR.test(result)
const isCredit = (result: string) => result.length < 400 && /credit balance is too low/i.test(result)
const retryable = (result: string) => isLimit(result) || isAuth(result) || isCredit(result) || (result.length < 400 && LOST_PROMPT.test(result))

let limitedSince: number | null = null
let creditsUntil = 0
let creditsDead = false
const onCredits = () => Boolean(API_KEY) && !creditsDead && Date.now() < creditsUntil
const authEnv = (): Record<string, string> => (onCredits() ? { ANTHROPIC_API_KEY: API_KEY } : {})

export async function claudeOnce(args: string[], o: { cwd: string; env?: Record<string, string>; stdin: string; account?: string }) {
  const started = Date.now()
  const promptFile = path.join(OUT, "prompts", `${crypto.randomUUID()}.txt`)
  mkdirSync(path.dirname(promptFile), { recursive: true })
  writeFileSync(promptFile, o.stdin)
  const credits = onCredits()
  const account = credits || !o.account || (o.account === CSWAP_ACCOUNT && !process.env.BENCH_CSWAP_PIN) ? null : o.account
  const cli = ["claude", "-p", "--output-format", "json", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', ...args]
  const proc = Bun.spawn(account ? ["cswap", "run", account, "--", ...cli.slice(1)] : cli, {
    cwd: o.cwd,
    env: { ...process.env, ...(account ? {} : { CLAUDE_CONFIG_DIR: CONFIG_DIR }), ...authEnv(), ...o.env },
    stdin: Bun.file(promptFile),
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), 25 * 60_000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  clearTimeout(timer)
  await proc.exited
  rmSync(promptFile, { force: true })
  let json: any
  try {
    json = JSON.parse(stdout)
  } catch {
    json = { is_error: true, result: `${stdout.slice(0, 300)} ${stderr.slice(0, 300)}` }
  }
  const limited = isLimit(String(json.result ?? ""))
  if (!limited && !credits) limitedSince = null
  if (limited) limitedUntil.set(account ?? CSWAP_ACCOUNT, Date.now() + LIMIT_HOLD_MS)
  return { ...json, wallMs: Date.now() - started, credits, account: account ?? CSWAP_ACCOUNT }
}

async function backoffFor(result: string, paidWithCredits: boolean, account: string | undefined): Promise<number | null> {
  if (isAuth(result)) {
    console.log(`  login expired on the bench account; refreshing through cswap`)
    await refreshLogin()
    return 2_000
  }
  if (isCredit(result)) {
    if (!creditsDead) console.log(`  API credits are exhausted; staying on the subscription from now on`)
    creditsDead = true
    creditsUntil = 0
    return 10 * 60_000
  }
  if (!isLimit(result)) return 5_000
  if (account !== undefined && chooseAccount() !== account) throw new AccountLimited(`account ${account} limited`)
  if (paidWithCredits) return 60_000
  limitedSince ??= Date.now()
  if (API_KEY && !creditsDead && Date.now() - limitedSince >= CREDITS_AFTER_MS) {
    creditsUntil = Date.now() + CREDITS_FOR_MS
    limitedSince = null
    console.log(`  subscription limited for ${Math.round(CREDITS_AFTER_MS / 60_000)}m; using API credits until ${new Date(creditsUntil).toLocaleTimeString()}`)
    return null
  }
  return 10 * 60_000
}

export async function claude(args: string[] | (() => string[]), o: { cwd: string; env?: Record<string, string>; stdin: string; account?: string }): Promise<any> {
  for (let attempt = 0; ; attempt += 1) {
    const out = await claudeOnce(typeof args === "function" ? args() : args, o)
    const result = String(out.result ?? "")
    if (!retryable(result) || attempt >= 40) return out
    const wait = await backoffFor(result, Boolean(out.credits), o.account)
    if (wait === null) continue
    console.log(`  retrying in ${Math.round(wait / 1000)}s: ${result.slice(0, 80)}`)
    await Bun.sleep(wait)
  }
}
