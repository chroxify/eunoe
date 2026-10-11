import { existsSync } from "node:fs"
import path from "node:path"
import { claudeConfigDirs, compactionOwner, readConfig, saveConfig } from "../../config"
import type { Config } from "../../config/types"
import { editSettings, withEunoe } from "../proxy/claude-settings"
import { routedDirs } from "../proxy/inspect"
import { startService } from "../proxy/service"
import { clearWatch } from "../proxy/watch"
import { isKnown, sessionArgs, shortId } from "../sessions"
import { flagValues } from "../terminal/args"
import { c, fail, line, listFiles, note, ok, rows, tilde } from "../terminal/ui"
import type { Command } from "../types"
import { MODE_DESCRIPTIONS } from "./constants"

function scoped(config: Config, ids: string[]): Partial<Config> {
  if (ids.length === 0) return { scope: "all" }
  const managingAll = config.scope === "all" && routedDirs(config).length > 0
  const sessions = { ...config.sessions }
  for (const id of ids) {
    const { mode, ...rest } = sessions[id] ?? {}
    sessions[id] = mode && mode !== "off" ? { mode, ...rest } : rest
  }
  return { scope: managingAll ? "all" : "sessions", sessions }
}

export const start: Command = {
  summary: "Route Claude Code through eunoe",
  usage: "eunoe start [--session <id>] [--config-dir <dir>]",
  details: [
    "Starts the background proxy if it isn't running (setting it up the first time)",
    "and points Claude Code at it through ANTHROPIC_BASE_URL in settings.json.",
    "New sessions pick it up; restart the ones already running.",
    "",
    "With --session, eunoe manages only the sessions you name and passes the rest",
    "through untouched. Session ids are in Claude Code's /status, or `eunoe status`.",
  ],
  options: [
    ["--session <id>", "Only manage this session (repeatable; a unique prefix is enough)"],
    ["--config-dir <dir>", "Also manage this Claude config directory (repeatable, remembered)"],
  ],
  async run(args) {
    const added = flagValues(args, "--config-dir").map((dir) => path.resolve(dir))
    for (const dir of added) if (!existsSync(dir)) fail(`No such directory: ${tilde(dir)}`)
    if (added.length > 0) saveConfig({ claudeConfigDirs: [...new Set([...readConfig().claudeConfigDirs, ...added])] })
    const ids = sessionArgs(args)
    saveConfig(scoped(readConfig(), ids))
    const config = readConfig()

    line()
    if (!(await startService(config))) fail("Claude Code was left alone because the proxy isn't up.", "Nothing is routed through a proxy that can't answer. Fix the proxy and run `eunoe start` again.")
    clearWatch()
    const touched = editSettings(claudeConfigDirs(config), (settings) => withEunoe(settings, config.port, compactionOwner(config)))
    ok("Claude Code routed through eunoe")
    listFiles(touched.length > 0 ? touched : routedDirs(config).map((dir) => path.join(dir, "settings.json")))
    line()
    rows([
      ["Mode", `${c.bold(config.mode)}  ${c.dim(MODE_DESCRIPTIONS[config.mode])}`],
      [
        "Sessions",
        config.scope === "all"
          ? "all"
          : `only ${Object.entries(config.sessions)
              .filter(([, own]) => own.mode !== "off")
              .map(([id]) => shortId(id))
              .join(", ")}`,
      ],
    ])
    line()
    const unseen = ids.filter((id) => !isKnown(id))
    if (unseen.length > 0) note(`Not seen through eunoe yet: ${unseen.map(shortId).join(", ")}. It applies once that session's requests come through; one started before routing needs a restart.`)
    else note(ids.length > 0 ? "Takes effect on the session's next request." : "New sessions go through eunoe. Restart any that are already running.")
    line()
  },
}
