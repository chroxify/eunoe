import { readConfig } from "../../config"
import { VERSION } from "../../constants"
import { serve as startProxy } from "../../proxy/server"
import { proxyUrl } from "../proxy/claude-settings"
import { probe } from "../proxy/inspect"
import { c, fail, line } from "../terminal/ui"
import type { Command } from "../types"

export const serve: Command = {
  summary: "Run the proxy in the foreground",
  usage: "eunoe serve",
  details: ["`eunoe start` runs this for you in the background. Use it directly where there is no launchd."],
  hidden: true,
  async run() {
    const config = readConfig()
    if (await probe(config.port)) fail(`Something is already serving eunoe on port ${config.port}`, "Stop it first, or set another port in ~/.eunoe/config.json.")
    startProxy(config.port)
    line(`${c.bold("eunoe")} ${c.dim(VERSION)}  listening on ${c.cyan(proxyUrl(config.port))}  ${c.dim(`mode ${config.mode} · Ctrl-C to stop`)}`)
  },
}
