import path from "node:path"
import { type Config, modeFor, overrides, readConfig } from "../../config"
import { paths } from "../../config/paths"
import { rerankKey } from "../../context/recall/rerank"
import type { Health } from "../../proxy/server"
import { seenSessions } from "../../proxy/sessions"
import { VERSION } from "../../version"
import type { Command } from "../command"
import { BLOCKING_LIMIT_ENV, proxyUrl, readSettings } from "../proxy/claude-settings"
import { probe, RECENT_REQUESTS, type RequestRecord, recentRequests, routedDirs, runsStaleCode } from "../proxy/inspect"
import * as launchd from "../proxy/launchd"
import { PROXY_AGENT } from "../proxy/service"
import { perSession, type SessionStats, savedShare, type Totals, totals, withinWindow } from "../proxy/stats"
import { readWatch } from "../proxy/watch"
import { shortId } from "../sessions"
import { ago, c, line, percent, plural, rows, table, tilde, tokens, warn } from "../terminal/ui"
import { MODE_DESCRIPTIONS } from "./mode"

const dot = (on: boolean) => (on ? c.green("●") : c.red("○"))

const settingsFiles = (dirs: string[]) => dirs.map((dir) => tilde(path.join(dir, "settings.json"))).join(", ")

function summary(title: string, sum: Totals) {
  const hit = sum.cacheRead + sum.cacheWrite + sum.uncached
  const folds = sum.folds && sum.lastFold ? `  ${c.dim(`${plural(sum.folds, "fold")}, last ${ago(sum.lastFold)}`)}` : ""
  const hitRate = hit ? c.dim(`  (${percent(sum.cacheRead / hit)} hit)`) : ""
  const saved = sum.saved > 0 ? `${c.bold(c.green(tokens(sum.saved)))} input tokens not sent  ${c.dim(`(${percent(sum.saved / (sum.sent + sum.saved))} less than plain Claude Code)`)}` : c.dim("no data yet")
  line()
  line(`  ${title}`)
  rows(
    [
      ["Requests", `${c.bold(sum.requests.toLocaleString())}${folds}`],
      ["Cache", `${c.bold(tokens(sum.cacheRead))} read  ${c.dim("·")}  ${tokens(sum.cacheWrite)} written  ${c.dim("·")}  ${tokens(sum.uncached)} uncached${hitRate}`],
      ["Saved", saved],
    ],
    4,
  )
}

function recallLine(config: Config, recent: RequestRecord[]) {
  if (config.rerank === "off") return "bm25"
  if (!rerankKey()) return `bm25  ${c.dim(`(${config.rerank} needs a key in ${tilde(paths.typesafeKey)} or TYPESAFE_API_KEY)`)}`
  const last = recent.findLast((r) => r.reranked || r.rerankError)
  if (last?.rerankError) return `bm25  ${c.yellow(`(${config.rerank} failing: ${last.rerankError.replace(/^[^:]+: /, "")}, last ${ago(last.ts)})`)}`
  return `bm25 ${c.dim("→")} ${config.rerank}`
}

function sessionRow(config: Config, stats: Map<string, SessionStats>, [id, session]: ReturnType<typeof seenSessions>[number]) {
  const active = modeFor(config, id)
  const own = Object.entries(overrides(config.sessions[id]))
    .map(([name, value]) => `${name} ${value}`)
    .join(" · ")
  const stat = stats.get(id)
  const managed = active !== "off"
  const saved = stat ? savedShare(stat.context, stat.plain) : null
  return [
    c.cyan(shortId(id)),
    managed ? c.green(active) : c.dim("off"),
    session.cwd ? tilde(session.cwd) : c.dim("–"),
    stat?.turns ? c.dim(`${stat.turns} turns`) : "",
    stat && managed ? `${c.bold(tokens(stat.context))} ctx${stat.fixed ? c.dim(` (${tokens(stat.fixed)} fixed)`) : ""}` : "",
    saved !== null && managed ? (saved > 0 ? c.green(`−${percent(saved)}`) : c.dim("±0")) : "",
    c.dim(ago(session.lastSeen)),
    own ? c.dim(own) : "",
  ]
}

function sessionsTable(config: Config, stats: Map<string, SessionStats>) {
  const sessions = seenSessions().slice(0, 5)
  if (sessions.length === 0) return
  line()
  line(`  ${c.dim("Sessions")}`)
  table(sessions.map((entry) => sessionRow(config, stats, entry)))
}

function warnings(config: Config, health: Health | null, routed: string[], recent: RequestRecord[]) {
  const notes: string[] = []
  const watch = readWatch()
  if (watch.paused.length > 0)
    notes.push(`The proxy stopped answering ${watch.pausedAt ? ago(watch.pausedAt) : ""}, so Claude Code was sent straight to the API. Routing comes back by itself once the proxy does; ${c.bold("eunoe start")} forces it.`)
  if (health && health.mode !== config.mode) notes.push(`The running proxy reports mode ${health.mode}; it switches on its next request.`)
  if (health && runsStaleCode(health)) notes.push(`The proxy is running older code than what's installed. ${c.bold("eunoe start")} restarts it.`)
  const unguarded = config.mode !== "off" ? routed.filter((dir) => readSettings(dir).env?.[BLOCKING_LIMIT_ENV] === undefined) : []
  if (unguarded.length > 0) notes.push(`Claude Code can still refuse to send near a full window in ${settingsFiles(unguarded)}. ${c.bold("eunoe start")} fixes it.`)
  const missed = recent.filter((r) => r.overflow || r.fit === "over")
  const lastMissed = missed.at(-1)
  if (lastMissed) notes.push(`${missed.length} request${missed.length === 1 ? "" : "s"} didn't fit the window on the first try, last ${ago(lastMissed.ts)}. Details in ${tilde(paths.requests)}.`)
  for (const text of notes) {
    line()
    warn(text)
  }
}

export const status: Command = {
  summary: "Show what eunoe is doing and saving",
  usage: "eunoe status",
  async run() {
    const config = readConfig()
    const health = await probe(config.port)
    const routed = routedDirs(config)
    const all = recentRequests(Number.POSITIVE_INFINITY)
    const recent = all.slice(-RECENT_REQUESTS)
    const sum = totals(withinWindow(all))
    const allTime = totals(all)

    line()
    line(`  ${c.bold("eunoe")} ${c.dim(VERSION)}`)
    line()
    rows([
      ["Proxy", health ? `${dot(true)} running on ${c.cyan(proxyUrl(config.port))}${launchd.isInstalled(PROXY_AGENT) ? c.dim("  launchd") : ""}` : `${dot(false)} not running ${c.dim("(eunoe start)")}`],
      ["Claude Code", routed.length > 0 ? `${dot(true)} routed ${c.dim(settingsFiles(routed))}` : `${c.dim("○")} not routed ${c.dim("(eunoe start)")}`],
      ["Mode", `${c.bold(config.mode)}  ${c.dim(MODE_DESCRIPTIONS[config.mode])}`],
      ["Sessions", config.scope === "all" ? "all" : `only the ones you started it for ${c.dim("(eunoe start --session <id>)")}`],
      ["Recall", recallLine(config, recent)],
    ])

    sessionsTable(config, perSession(all))

    if (sum.requests) summary(c.dim("Last 24h"), sum)
    if (allTime.requests > sum.requests) summary(`${c.dim("All time")}  ${c.dim(`since ${new Date(all[0].ts).toLocaleDateString()}`)}`, allTime)

    warnings(config, health, routed, recent)
    line()
  },
}
