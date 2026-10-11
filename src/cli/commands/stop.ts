import { claudeConfigDirs, readConfig, saveConfig } from "../../config"
import type { Command } from "../command"
import { editSettings, withoutEunoe } from "../proxy/claude-settings"
import { clearWatch } from "../proxy/watch"
import { sessionArgs, shortId } from "../sessions"
import { line, listFiles, note, ok } from "../terminal/ui"

export const stop: Command = {
  summary: "Send new sessions straight to the API again",
  usage: "eunoe stop [--session <id>]",
  details: [
    "Removes eunoe from Claude Code's settings and hands compaction back to it.",
    "The proxy stays up for sessions that are already running through it, so they",
    "keep working until you restart them. `eunoe start` turns it back on.",
    "",
    "With --session, only that session is passed through untouched from its next request.",
  ],
  options: [["--session <id>", "Stop managing just this session (repeatable; a unique prefix is enough)"]],
  run(args) {
    const config = readConfig()
    const ids = sessionArgs(args)
    if (ids.length > 0) {
      const sessions = { ...config.sessions }
      for (const id of ids) {
        if (config.scope === "all") sessions[id] = { ...sessions[id], mode: "off" }
        else delete sessions[id]
      }
      saveConfig({ sessions })
      ok(`eunoe off for ${ids.map(shortId).join(", ")} from the next request`)
      return
    }
    const touched = editSettings(claudeConfigDirs(config), (settings) => withoutEunoe(settings, config.port))
    clearWatch()
    line()
    ok("Claude Code no longer routed through eunoe")
    listFiles(touched)
    note("Sessions already running through eunoe keep using it until restarted.")
    line()
  },
}
