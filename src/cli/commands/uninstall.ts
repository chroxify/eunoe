import { claudeConfigDirs, loadConfig, saveConfig } from "../../config"
import { editSettings, withoutEunoe } from "../claude-settings"
import type { Command } from "../types"
import { c, line, listFiles, note, ok } from "../ui"

export const uninstall: Command = {
  summary: "Send new sessions straight to the API again",
  usage: "eunoe uninstall",
  details: [
    "Removes eunoe from Claude Code's settings and hands compaction back to it.",
    "The proxy keeps running as a passthrough, so sessions already pointed at it",
    "keep working. Run `eunoe stop` once they have been restarted.",
  ],
  run() {
    const config = loadConfig()
    const touched = editSettings(claudeConfigDirs(config), (settings) => withoutEunoe(settings, config.port))
    saveConfig({ mode: "off" })
    line()
    ok("Claude Code no longer routed through eunoe")
    listFiles(touched)
    note("The proxy stays up as a passthrough for sessions still using it.")
    line(`  ${c.dim("Once they're restarted:")} ${c.cyan("eunoe stop")}`)
    line()
  },
}
