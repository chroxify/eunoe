import path from "node:path"
import { modeFor, overrides, readConfig } from "../../config"
import { paths, RERANK_OFF } from "../../config/constants"
import { VERSION } from "../../constants"
import { rerankKey } from "../../context/recall/rerank"
import { seenSessions } from "../../proxy/sessions"
import { proxyUrl } from "../proxy/claude-settings"
import { BLOCKING_LIMIT_ENV, PROXY_AGENT, RECENT_REQUESTS } from "../proxy/constants"
import { probe, readSettings, recentRequests, routedDirs, runsStaleCode } from "../proxy/inspect"
import * as launchd from "../proxy/launchd"
import { perSession, savedShare, totals, withinWindow } from "../proxy/stats"
import type { Totals } from "../proxy/types"
import { readWatch } from "../proxy/watch"
import { shortId } from "../sessions"
import { ago, c, line, percent, rows, table, tilde, tokens, warn } from "../terminal/ui"
import type { Command } from "../types"
import { MODE_DESCRIPTIONS, SESSIONS_SHOWN } from "./constants"

const dot = (on: boolean) => (on ? c.green("●") : c.red("○"))

const summary = (title: string, sum: Totals) => {
  const hit = sum.cacheRead + sum.cacheWrite + sum.uncached
  line()
  line(`  ${title}`)
  rows(
    [
      ["Requests", `${c.bold(String(sum.requests))}${sum.folds ? `  ${c.dim(`${sum.folds} fold${sum.folds === 1 ? "" : "s"}, last ${ago(sum.lastFold!)}`)}` : ""}`],
      ["Cache", `${c.bold(tokens(sum.cacheRead))} read  ${c.dim("·")}  ${tokens(sum.cacheWrite)} written  ${c.dim("·")}  ${tokens(sum.uncached)} uncached${hit ? c.dim(`  (${percent(sum.cacheRead / hit)} hit)`) : ""}`],
      ["Saved", sum.saved > 0 ? `${c.bold(c.green(tokens(sum.saved)))} input tokens not sent  ${c.dim(`(${percent(sum.saved / (sum.sent + sum.saved))} less than plain Claude Code)`)}` : c.dim("no data yet")],
    ],
    4,
  )
}

function recallLine(config: ReturnType<typeof readConfig>, recent: ReturnType<typeof recentRequests>) {
  if (config.rerank === RERANK_OFF) return "bm25"
  if (!rerankKey()) return `bm25  ${c.dim(`(${config.rerank} needs a key in ${tilde(paths.typesafeKey)} or TYPESAFE_API_KEY)`)}`
  const lastRerank = [...recent].reverse().find((r) => r.reranked || r.rerankError)
  if (lastRerank?.rerankError) return `bm25  ${c.yellow(`(${config.rerank} failing: ${lastRerank.rerankError.replace(/^[^:]+: /, "")}, last ${ago(lastRerank.ts)})`)}`
  return `bm25 ${c.dim("→")} ${config.rerank}`
}

function sessionsTable(config: ReturnType<typeof readConfig>, stats: ReturnType<typeof perSession>) {
  const sessions = seenSessions().slice(0, SESSIONS_SHOWN)
  if (sessions.length === 0) return
  line()
  line(`  ${c.dim("Sessions")}`)
  table(
    sessions.map(([id, session]) => {
      const active = modeFor(config, id)
      const own = Object.entries(overrides(config.sessions[id]))
        .map(([name, value]) => `${name} ${value}`)
        .join(" · ")
      const stat = stats.get(id)
      const saved = stat ? savedShare(stat.context, stat.plain) : null
      return [
        c.cyan(shortId(id)),
        active === "off" ? c.dim("off") : c.green(active),
        session.cwd ? tilde(session.cwd) : c.dim("–"),
        stat?.turns ? c.dim(`${stat.turns} turns`) : "",
        stat && active !== "off" ? `${c.bold(tokens(stat.context))} ctx${stat.fixed ? c.dim(` (${tokens(stat.fixed)} fixed)`) : ""}` : "",
        saved !== null && active !== "off" ? (saved > 0 ? c.green(`−${percent(saved)}`) : c.dim("±0")) : "",
        c.dim(ago(session.lastSeen)),
        own ? c.dim(own) : "",
      ]
    }),
  )
}

function warnings(config: ReturnType<typeof readConfig>, health: Awaited<ReturnType<typeof probe>>, routed: string[], recent: ReturnType<typeof recentRequests>) {
  const notes: string[] = []
  const watch = readWatch()
  if (watch.paused.length > 0)
    notes.push(`The proxy stopped answering ${watch.pausedAt ? ago(watch.pausedAt) : ""}, so Claude Code was sent straight to the API. Routing comes back by itself once the proxy does; ${c.bold("eunoe start")} forces it.`)
  if (health && health.mode !== config.mode) notes.push(`The running proxy reports mode ${health.mode}; it switches on its next request.`)
  if (health && runsStaleCode(health)) notes.push(`The proxy is running older code than what's installed. ${c.bold("eunoe start")} restarts it.`)
  const unguarded = config.mode !== "off" ? routed.filter((dir) => readSettings(dir).env?.[BLOCKING_LIMIT_ENV] === undefined) : []
  if (unguarded.length > 0) notes.push(`Claude Code can still refuse to send near a full window in ${unguarded.map((dir) => tilde(path.join(dir, "settings.json"))).join(", ")}. ${c.bold("eunoe start")} fixes it.`)
  const missed = recent.filter((r) => r.overflow || r.fit === "over")
  if (missed.length > 0) notes.push(`${missed.length} request${missed.length === 1 ? "" : "s"} didn't fit the window on the first try, last ${ago(missed.at(-1)!.ts)}. Details in ${tilde(paths.requests)}.`)
  for (const note of notes) {
    line()
    warn(note)
  }
}

export const status: Command = {
  summary: "Show what eunoe is doing and saving",
  usage: "eunoe status",
  async run() {
    const config = readConfig()
    const health = await probe(config.port)
    const routed = routedDirs(config)
    const all = recentRequests(Infinity)
    const recent = all.slice(-RECENT_REQUESTS)
    const stats = perSession(recent)
    const sum = totals(withinWindow(recent))
    const allTime = totals(all)

    line()
    line(`  ${c.bold("eunoe")} ${c.dim(VERSION)}`)
    line()

    const recall = recallLine(config, recent)
    rows([
      ["Proxy", health ? `${dot(true)} running on ${c.cyan(proxyUrl(config.port))}${launchd.isInstalled(PROXY_AGENT) ? c.dim("  launchd") : ""}` : `${dot(false)} not running ${c.dim("(eunoe start)")}`],
      ["Claude Code", routed.length > 0 ? `${dot(true)} routed ${c.dim(routed.map((dir) => tilde(path.join(dir, "settings.json"))).join(", "))}` : `${c.dim("○")} not routed ${c.dim("(eunoe start)")}`],
      ["Mode", `${c.bold(config.mode)}  ${c.dim(MODE_DESCRIPTIONS[config.mode])}`],
      ["Sessions", config.scope === "all" ? "all" : `only the ones you started it for ${c.dim("(eunoe start --session <id>)")}`],
      ["Recall", recall],
    ])

    sessionsTable(config, stats)

    if (sum.requests) summary(c.dim("Last 24h"), sum)
    if (allTime.requests > sum.requests) summary(`${c.dim("All time")}  ${c.dim(`since ${new Date(all[0].ts).toLocaleDateString()}`)}`, allTime)

    warnings(config, health, routed, recent)
    line()
  },
}
