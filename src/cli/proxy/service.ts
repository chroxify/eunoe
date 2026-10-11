import path from "node:path"
import { paths } from "../../config/constants"
import type { Config } from "../../config/types"
import type { Health } from "../../proxy/types"
import { c, line, ok, warn } from "../terminal/ui"
import { proxyUrl } from "./claude-settings"
import { PROXY_AGENT, START_POLL_MS, START_TIMEOUT_MS, WATCH_AGENT } from "./constants"
import { probe, runsStaleCode } from "./inspect"
import * as launchd from "./launchd"

const cli = () => path.resolve(process.argv[1] ?? "")

async function waitFor(port: number, ready: (health: Health | null) => boolean) {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (ready(await probe(port))) return true
    await Bun.sleep(START_POLL_MS)
  }
  return false
}

export async function startService(config: Config) {
  if (!launchd.supported) {
    if (await probe(config.port)) return true
    warn("No launchd here, so keep the proxy running yourself:")
    line(`    ${c.cyan("eunoe serve")}`)
    return false
  }
  launchd.installAgent(PROXY_AGENT, [process.execPath, cli(), "serve"], paths.proxyLog)
  launchd.installAgent(WATCH_AGENT, [process.execPath, cli(), "watch"], paths.proxyLog)
  const running = await probe(config.port)
  if (running && runsStaleCode(running)) {
    launchd.restartAgent(PROXY_AGENT)
    await waitFor(config.port, (health) => health !== null && health.pid !== running.pid)
  }
  if (await waitFor(config.port, (health) => health !== null)) {
    ok(`Proxy running in the background on ${c.cyan(proxyUrl(config.port))}`)
    return true
  }
  warn(`The proxy didn't answer on ${proxyUrl(config.port)}. Check ${paths.proxyLog}.`)
  return false
}

export function removeService() {
  const removed = launchd.removeAgent(PROXY_AGENT)
  launchd.removeAgent(WATCH_AGENT)
  return removed
}
