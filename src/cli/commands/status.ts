import path from "node:path"
import { loadConfig, modeFor, overrides } from "../../config"
import { paths, RERANK_OFF } from "../../config/constants"
import { rerankKey } from "../../context/rerank"
import { seenSessions } from "../../proxy/sessions"
import { VERSION } from "../../version"
import { proxyUrl } from "../claude-settings"
import { MODE_DESCRIPTIONS, SESSIONS_SHOWN } from "../constants"
import { probe, recentRequests, routedDirs } from "../inspect"
import * as launchd from "../launchd"
import { shortId } from "../sessions"
import { perSession, savedShare, totals, withinWindow } from "../stats"
import type { Command } from "../types"
import { ago, c, line, percent, rows, table, tilde, tokens, warn } from "../ui"

const dot = (on: boolean) => (on ? c.green("●") : c.red("○"))

export const status: Command = {
  summary: "Show what eunoe is doing and saving",
  usage: "eunoe status",
  async run() {
    const config = loadConfig()
    const health = await probe(config.port)
    const routed = routedDirs(config)
    const recent = recentRequests()
    const today = withinWindow(recent)
    const stats = perSession(recent)
    const sum = totals(today)

    line()
    line(`  ${c.bold("eunoe")} ${c.dim(VERSION)}`)
    line()

    const recall = config.rerank === RERANK_OFF ? "bm25" : rerankKey() ? `bm25 ${c.dim("→")} ${config.rerank}` : `bm25  ${c.dim(`(${config.rerank} needs a key in ${tilde(paths.typesafeKey)} or TYPESAFE_API_KEY)`)}`
    rows([
      ["Proxy", health ? `${dot(true)} running on ${c.cyan(proxyUrl(config.port))}${launchd.isInstalled() ? c.dim("  launchd") : ""}` : `${dot(false)} not running ${c.dim("(eunoe start)")}`],
      ["Claude Code", routed.length ? `${dot(true)} routed ${c.dim(routed.map((dir) => tilde(path.join(dir, "settings.json"))).join(", "))}` : `${c.dim("○")} not routed ${c.dim("(eunoe start)")}`],
      ["Mode", `${c.bold(config.mode)}  ${c.dim(MODE_DESCRIPTIONS[config.mode])}`],
      ["Sessions", config.scope === "all" ? "all" : `only the ones you started it for ${c.dim("(eunoe start --session <id>)")}`],
      ["Recall", recall],
    ])

    const sessions = seenSessions().slice(0, SESSIONS_SHOWN)
    if (sessions.length) {
      line()
      line(`  ${c.dim("Sessions")}`)
      table(sessions.map(([id, session]) => {
        const active = modeFor(config, id)
        const own = Object.entries(overrides(config.sessions[id])).map(([name, value]) => `${name} ${value}`).join(" · ")
        const stat = stats.get(id)
        const saved = stat ? savedShare(stat.context, stat.plain) : null
        return [
          c.cyan(shortId(id)),
          active === "off" ? c.dim("off") : c.green(active),
          session.cwd ? tilde(session.cwd) : c.dim("–"),
          stat?.turns ? c.dim(`${stat.turns} turns`) : "",
          stat && active !== "off" ? `${c.bold(tokens(stat.context))} ctx` : "",
          saved !== null && active !== "off" ? (saved > 0 ? c.green(`−${percent(saved)}`) : c.dim("±0")) : "",
          c.dim(ago(session.lastSeen)),
          own ? c.dim(own) : "",
        ]
      }))
    }

    if (sum.requests) {
      const hit = sum.cacheRead + sum.cacheWrite + sum.uncached
      line()
      line(`  ${c.dim("Last 24h")}`)
      rows([
        ["Requests", `${c.bold(String(sum.requests))}${sum.folds ? `  ${c.dim(`${sum.folds} fold${sum.folds === 1 ? "" : "s"}, last ${ago(sum.lastFold!)}`)}` : ""}`],
        ["Cache", `${c.bold(tokens(sum.cacheRead))} read  ${c.dim("·")}  ${tokens(sum.cacheWrite)} written  ${c.dim("·")}  ${tokens(sum.uncached)} uncached${hit ? c.dim(`  (${percent(sum.cacheRead / hit)} hit)`) : ""}`],
        ["Saved", sum.saved > 0 ? `${c.bold(c.green(tokens(sum.saved)))} input tokens not sent  ${c.dim(`(${percent(sum.saved / (sum.sent + sum.saved))} less than plain Claude Code)`)}` : c.dim("no data yet")],
      ], 4)
    }

    if (health && health.mode !== config.mode) {
      line()
      warn(`The running proxy reports mode ${health.mode}; it switches on its next request.`)
    }
    line()
  },
}
