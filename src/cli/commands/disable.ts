import { claudeConfigDirs, loadConfig, saveConfig } from "../../config"
import { editSettings, withoutEunoe } from "../claude-settings"
import { sessionArgs, shortId } from "../sessions"
import type { Command } from "../types"
import { line, listFiles, note, ok } from "../ui"

export const disable: Command = {
  summary: "Send new sessions straight to the API again",
  usage: "eunoe disable [--session <id>]",
  details: [
    "Removes eunoe from Claude Code's settings and hands compaction back to it.",
    "The proxy stays up for sessions that are already running through it, so they",
    "keep working until you restart them. `eunoe enable` turns it back on.",
    "",
    "With --session, only that session is passed through untouched from its next request.",
  ],
  options: [["--session <id>", "Stop managing just this session (repeatable; a unique prefix is enough)"]],
  run(args) {
    const config = loadConfig()
    const ids = sessionArgs(args)
    if (ids.length) {
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
    line()
    ok("Claude Code no longer routed through eunoe")
    listFiles(touched)
    note("Sessions already running through eunoe keep using it until restarted.")
    line()
  },
}
