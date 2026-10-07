import { claudeConfigDirs, loadConfig, saveConfig } from "../../config"
import type { Mode } from "../../config/types"
import { editSettings, withCompactionOwner } from "../claude-settings"
import { MODE_DESCRIPTIONS } from "../constants"
import * as launchd from "../launchd"
import type { Command } from "../types"
import { c, fail, line, ok } from "../ui"

export const mode: Command = {
  summary: "Show or switch how eunoe manages context",
  usage: "eunoe mode [compact | trim | off]",
  details: ["Takes effect on the next request; no restart needed."],
  run(args) {
    const config = loadConfig()
    const next = args[0] as Mode | undefined
    if (!next) {
      line()
      for (const [name, description] of Object.entries(MODE_DESCRIPTIONS) as Array<[Mode, string]>) {
        const current = name === config.mode
        line(`  ${current ? c.green("●") : c.dim("○")} ${current ? c.bold(name.padEnd(8)) : name.padEnd(8)}  ${c.dim(description)}`)
      }
      line()
      return
    }
    if (!(next in MODE_DESCRIPTIONS)) fail(`Unknown mode: ${next}`, "Choose compact, trim or off.")
    saveConfig({ mode: next })
    if (launchd.isInstalled()) editSettings(claudeConfigDirs(loadConfig()), (settings) => withCompactionOwner(settings, next))
    ok(`Mode ${c.bold(next)}  ${c.dim(MODE_DESCRIPTIONS[next])}`)
  },
}
