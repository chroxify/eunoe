import path from "node:path"
import { paths } from "../config/constants"
import type { Config } from "../config/types"
import { proxyUrl } from "./claude-settings"
import { START_POLL_MS, START_TIMEOUT_MS } from "./constants"
import { probe, runsStaleCode } from "./inspect"
import * as launchd from "./launchd"
import { c, line, ok, warn } from "./ui"

async function waitForProxy(port: number) {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await probe(port)) return true
    await Bun.sleep(START_POLL_MS)
  }
  return false
}

async function waitForRestart(port: number, oldPid: number) {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const health = await probe(port)
    if (health && health.pid !== oldPid) return
    await Bun.sleep(START_POLL_MS)
  }
}

export async function startService(config: Config) {
  if (!launchd.supported) {
    if (await probe(config.port)) return true
    warn("No launchd here, so keep the proxy running yourself:")
    line(`    ${c.cyan("eunoe serve")}`)
    return false
  }
  launchd.installAgent([process.execPath, path.join(import.meta.dir, "main.ts"), "serve"], paths.proxyLog)
  const running = await probe(config.port)
  if (running && runsStaleCode(running)) {
    launchd.restartAgent()
    await waitForRestart(config.port, running.pid)
  }
  if (await waitForProxy(config.port)) {
    ok(`Proxy running in the background on ${c.cyan(proxyUrl(config.port))}`)
    return true
  }
  warn(`The proxy didn't answer on ${proxyUrl(config.port)} yet. Check ${paths.proxyLog}.`)
  return false
}
