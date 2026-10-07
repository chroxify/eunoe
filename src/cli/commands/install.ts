import { existsSync } from "node:fs"
import path from "node:path"
import { claudeConfigDirs, loadConfig, saveConfig } from "../../config"
import { paths } from "../../config/constants"
import { flagValues } from "../args"
import { editSettings, proxyUrl, withEunoe } from "../claude-settings"
import { MODE_DESCRIPTIONS } from "../constants"
import { routedDirs } from "../inspect"
import * as launchd from "../launchd"
import type { Command } from "../types"
import { c, fail, line, listFiles, note, ok, rows, tilde, warn } from "../ui"

export const install: Command = {
  summary: "Route Claude Code through eunoe and keep it running",
  usage: "eunoe install [--config-dir <dir>]",
  details: [
    "Starts the proxy in the background and points Claude Code at it by setting",
    "ANTHROPIC_BASE_URL in settings.json. New sessions pick it up; restart running ones.",
  ],
  options: [["--config-dir <dir>", "Also manage this Claude config directory (repeatable, remembered)"]],
  run(args) {
    const added = flagValues(args, "--config-dir").map((dir) => path.resolve(dir))
    for (const dir of added) if (!existsSync(dir)) fail(`No such directory: ${tilde(dir)}`)
    if (added.length) saveConfig({ claudeConfigDirs: [...new Set([...loadConfig().claudeConfigDirs, ...added])] })
    const config = loadConfig()

    line()
    if (launchd.supported) {
      launchd.installAgent([process.execPath, path.join(import.meta.dir, "..", "main.ts"), "serve"], paths.proxyLog)
      ok(`Proxy running in the background on ${c.cyan(proxyUrl(config.port))}`)
    } else {
      warn("No launchd here, so keep the proxy running yourself:")
      line(`    ${c.cyan("eunoe serve")}`)
    }
    const touched = editSettings(claudeConfigDirs(config), (settings) => withEunoe(settings, config.port, config.mode))
    ok("Claude Code routed through eunoe")
    listFiles(touched.length ? touched : routedDirs(config).map((dir) => path.join(dir, "settings.json")))
    line()
    rows([["Mode", `${c.bold(config.mode)}  ${c.dim(MODE_DESCRIPTIONS[config.mode])}`]])
    line()
    note(`New sessions go through eunoe. Restart any that are already running.`)
    line()
  },
}
