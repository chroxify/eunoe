import { loadConfig } from "../../config"
import { routedDirs } from "../inspect"
import * as launchd from "../launchd"
import type { Command } from "../types"
import { fail, note, ok } from "../ui"

export const stop: Command = {
  summary: "Stop the background proxy",
  usage: "eunoe stop",
  details: ["Sessions still pointed at the proxy will fail until restarted, so run `eunoe uninstall` first."],
  run() {
    if (routedDirs(loadConfig()).length) fail("Claude Code is still routed through eunoe", "Run `eunoe uninstall` first, then restart your sessions.")
    if (launchd.removeAgent()) ok("Background proxy stopped")
    else note("The proxy isn't running as a background service.")
  },
}
