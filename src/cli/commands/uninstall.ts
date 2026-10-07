import { claudeConfigDirs, loadConfig } from "../../config"
import { editSettings, withoutEunoe } from "../claude-settings"
import * as launchd from "../launchd"
import type { Command } from "../types"
import { c, line, listFiles, note, ok, warn } from "../ui"

export const uninstall: Command = {
  summary: "Disable eunoe and remove the background proxy",
  usage: "eunoe uninstall",
  details: [
    "Everything `disable` does, then stops the proxy and removes its background service.",
    "Sessions still running through eunoe lose their connection, so restart them first.",
    "Your config and transcripts in ~/.eunoe are kept.",
  ],
  run() {
    const config = loadConfig()
    const touched = editSettings(claudeConfigDirs(config), (settings) => withoutEunoe(settings, config.port))
    line()
    ok("Claude Code no longer routed through eunoe")
    listFiles(touched)
    if (launchd.removeAgent()) ok("Background proxy stopped and removed")
    else note("No background proxy was installed.")
    warn(`Restart any Claude Code session that was still using eunoe.`)
    line(`  ${c.dim("Data kept in")} ~/.eunoe`)
    line()
  },
}
