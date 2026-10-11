import { readConfig } from "../../config"
import { VERSION } from "../../constants"
import { serve as startProxy } from "../../proxy/server"
import { proxyUrl } from "../proxy/claude-settings"
import { BIND_RETRIES, BIND_RETRY_MS } from "../proxy/constants"
import { probe } from "../proxy/inspect"
import { c, fail, line, warn } from "../terminal/ui"
import type { Command } from "../types"

async function bind(port: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      return startProxy(port)
    } catch (error) {
      if (attempt >= BIND_RETRIES) throw error
      warn(`Port ${port} is busy (${String(error)}), trying again in ${BIND_RETRY_MS}ms`)
      await Bun.sleep(BIND_RETRY_MS)
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
    process.on("uncaughtException", (error) => warn(`eunoe kept going after an error: ${String(error)}`))
    process.on("unhandledRejection", (error) => warn(`eunoe kept going after an error: ${String(error)}`))
    await bind(config.port)
    line(`${c.bold("eunoe")} ${c.dim(VERSION)}  listening on ${c.cyan(proxyUrl(config.port))}  ${c.dim(`mode ${config.mode} · Ctrl-C to stop`)}`)
  },
}
