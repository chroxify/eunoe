import path from "node:path"
import { loadConfig } from "../../config"
import { VERSION } from "../../version"
import { proxyUrl } from "../claude-settings"
import { MODE_DESCRIPTIONS } from "../constants"
import { probe, recentRequests, routedDirs } from "../inspect"
import * as launchd from "../launchd"
import type { Command } from "../types"
import { ago, c, line, rows, tilde, tokens, warn } from "../ui"

export const status: Command = {
  summary: "Show what eunoe is doing",
  usage: "eunoe status",
  async run() {
    const config = loadConfig()
    const health = await probe(config.port)
    const routed = routedDirs(config)
    const recent = recentRequests()

    line()
    line(`  ${c.bold("eunoe")} ${c.dim(VERSION)}`)
    line()
    rows([
      ["Proxy", health ? `${c.green("●")} running on ${c.cyan(proxyUrl(config.port))}` : `${c.red("○")} not running`],
      ["Claude Code", routed.length ? `${c.green("●")} routed through eunoe` : `${c.dim("○")} not routed ${c.dim("(eunoe install)")}`],
      ["Mode", `${c.bold(config.mode)}  ${c.dim(MODE_DESCRIPTIONS[config.mode])}`],
      ["Search", `${config.search} transcripts`],
      ["Background", launchd.isInstalled() ? "launchd agent" : c.dim("none")],
    ])
    for (const dir of routed) line(`  ${" ".repeat(13)}${c.dim(tilde(path.join(dir, "settings.json")))}`)

    if (recent.length) {
      const sum = (key: string) => recent.reduce((total, entry) => total + (entry[key] ?? 0), 0)
      const compactions = recent.filter((entry) => entry.compacted)
      line()
      line(`  ${c.dim(`Last ${recent.length} requests`)}`)
      rows([
        ["Cache", `${c.bold(tokens(sum("cacheRead")))} read  ·  ${tokens(sum("cacheWrite"))} written  ·  ${tokens(sum("uncached"))} uncached`],
        ["Cuts", compactions.length ? `${compactions.length}, last ${ago(compactions.at(-1)!.ts)}` : c.dim("none yet")],
      ])
    }
    if (health && health.mode !== config.mode) {
      line()
      warn(`The running proxy reports mode ${health.mode}; it switches on its next request.`)
    }
    line()
  },
}
