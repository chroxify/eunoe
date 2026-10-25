import { readConfig } from "../../config"
import { serve as startProxy } from "../../proxy/server"
import { warmRecentSessions } from "../../proxy/warm"
import { VERSION } from "../../version"
import type { Command } from "../command"
import { proxyUrl } from "../proxy/claude-settings"
import { probe } from "../proxy/inspect"
import { c, fail, line, warn } from "../terminal/ui"

async function bind(port: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      return startProxy(port)
    } catch (error) {
      if (attempt >= 30) throw error
      warn(`Port ${port} is busy (${String(error)}), trying again in 1000ms`)
      await Bun.sleep(1_000)
    }
  }
}

export const serve: Command = {
  summary: "Run the proxy in the foreground",
  usage: "eunoe serve",
  details: ["`eunoe start` runs this for you in the background. Use it directly where there is no launchd."],
  hidden: true,
  async run() {
    const config = readConfig()
    if (await probe(config.port)) fail(`Something is already serving eunoe on port ${config.port}`, "Stop it first, or set another port in ~/.eunoe/config.json.")
    const keepGoing = (error: unknown) => warn(`eunoe kept going after an error: ${String(error)}`)
    process.on("uncaughtException", keepGoing)
    process.on("unhandledRejection", keepGoing)
    await bind(config.port)
    if (config.mode !== "off") void warmRecentSessions(config).catch(keepGoing)
    line(`${c.bold("eunoe")} ${c.dim(VERSION)}  listening on ${c.cyan(proxyUrl(config.port))}  ${c.dim(`mode ${config.mode} · Ctrl-C to stop`)}`)
  },
}
