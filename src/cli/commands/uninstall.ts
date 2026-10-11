import { claudeConfigDirs, readConfig } from "../../config"
import type { Command } from "../command"
import { editSettings, withoutEunoe } from "../proxy/claude-settings"
import { removeService } from "../proxy/service"
import { clearWatch } from "../proxy/watch"
import { c, line, listFiles, note, ok, warn } from "../terminal/ui"

export const uninstall: Command = {
  summary: "Stop eunoe and remove the background proxy",
  usage: "eunoe uninstall",
  details: ["Everything `stop` does, then shuts the proxy down and removes its background service.", "Sessions still running through eunoe lose their connection, so restart them first.", "Your config and transcripts in ~/.eunoe are kept."],
  run() {
    const config = readConfig()
    const touched = editSettings(claudeConfigDirs(config), (settings) => withoutEunoe(settings, config.port))
    clearWatch()
    line()
    ok("Claude Code no longer routed through eunoe")
    listFiles(touched)
    if (removeService()) ok("Background proxy stopped and removed")
    else note("No background proxy was installed.")
    warn(`Restart any Claude Code session that was still using eunoe.`)
    line(`  ${c.dim("Data kept in")} ~/.eunoe`)
    line()
  },
}
