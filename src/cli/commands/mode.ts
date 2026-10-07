import { compactionOwner, loadConfig, saveConfig } from "../../config"
import { MODES } from "../../config/constants"
import type { Mode } from "../../config/types"
import { editSettings, withCompactionOwner } from "../claude-settings"
import { MODE_DESCRIPTIONS } from "../constants"
import { routedDirs } from "../inspect"
import { isKnown, sessionArgs, shortId } from "../sessions"
import type { Command } from "../types"
import { c, fail, line, note, ok, warn } from "../ui"

export const mode: Command = {
  summary: "Show or switch how eunoe manages context",
  usage: "eunoe mode [compact | trim | off] [--session <id>]",
  details: ["Takes effect on the next request; no restart needed."],
  options: [["--session <id>", "Set the mode for just this session (repeatable; a unique prefix is enough)"]],
  run(args) {
    const config = loadConfig()
    const next = args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "--session") as Mode | undefined
    const ids = sessionArgs(args)
    if (!next) {
      line()
      for (const [name, description] of Object.entries(MODE_DESCRIPTIONS) as Array<[Mode, string]>) {
        const current = name === config.mode
        line(`  ${current ? c.green("●") : c.dim("○")} ${current ? c.bold(name.padEnd(8)) : name.padEnd(8)}  ${c.dim(description)}`)
      }
      const overrides = Object.entries(config.sessions).filter(([, value]) => value)
      if (overrides.length) {
        line()
        for (const [id, value] of overrides) line(`  ${c.dim(shortId(id))}  ${value}`)
      }
      line()
      return
    }
    if (!MODES.includes(next)) fail(`Unknown mode: ${next}`, "Choose compact, trim or off.")
    if (ids.length) {
      saveConfig({ sessions: { ...config.sessions, ...Object.fromEntries(ids.map((id) => [id, next])) } })
      ok(`Mode ${c.bold(next)} for ${ids.map(shortId).join(", ")}  ${c.dim(MODE_DESCRIPTIONS[next])}`)
      if (!routedDirs(config).length) warn("Claude Code isn't routed through eunoe. Run `eunoe enable --session <id>`.")
      const unseen = ids.filter((id) => !isKnown(id))
      if (unseen.length) note(`Not seen through eunoe yet: ${unseen.map(shortId).join(", ")}. Check the id in Claude Code's /status.`)
      return
    }
    saveConfig({ mode: next })
    const updated = loadConfig()
    editSettings(routedDirs(updated), (settings) => withCompactionOwner(settings, compactionOwner(updated)))
    ok(`Mode ${c.bold(next)}  ${c.dim(MODE_DESCRIPTIONS[next])}`)
  },
}
