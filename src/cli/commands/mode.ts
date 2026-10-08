import { compactionOwner, loadConfig, saveConfig } from "../../config"
import { MODES } from "../../config/constants"
import type { Mode } from "../../config/types"
import { editSettings, withCompactionOwner } from "../claude-settings"
import { MODE_DESCRIPTIONS } from "../constants"
import { routedDirs } from "../inspect"
import { interactive, select } from "../prompt"
import { isKnown, sessionArgs, shortId } from "../sessions"
import type { Command } from "../types"
import { c, fail, line, note, ok, warn } from "../ui"

function listModes(current: Mode) {
  line()
  for (const name of MODES) {
    const active = name === current
    line(`  ${active ? c.green("●") : c.dim("○")} ${active ? c.bold(name.padEnd(8)) : name.padEnd(8)}  ${c.dim(MODE_DESCRIPTIONS[name])}`)
  }
}

export function applyMode(next: Mode, ids: string[]) {
  const config = loadConfig()
  if (ids.length) {
    saveConfig({ sessions: { ...config.sessions, ...Object.fromEntries(ids.map((id) => [id, { ...config.sessions[id], mode: next }])) } })
    ok(`Mode ${c.bold(next)} for ${ids.map(shortId).join(", ")}  ${c.dim(MODE_DESCRIPTIONS[next])}`)
    if (!routedDirs(config).length) warn("Claude Code isn't routed through eunoe. Run `eunoe start --session <id>`.")
    const unseen = ids.filter((id) => !isKnown(id))
    if (unseen.length) note(`Not seen through eunoe yet: ${unseen.map(shortId).join(", ")}. Check the id in Claude Code's /status.`)
    return
  }
  saveConfig({ mode: next })
  const updated = loadConfig()
  editSettings(routedDirs(updated), (settings) => withCompactionOwner(settings, compactionOwner(updated)))
  ok(`Mode ${c.bold(next)}  ${c.dim(MODE_DESCRIPTIONS[next])}`)
}

export const mode: Command = {
  summary: "Pick how eunoe manages context",
  usage: "eunoe mode [default | compact | off] [--session <id>]",
  details: ["Without a mode it opens a picker. Takes effect on the next request; no restart needed."],
  options: [["--session <id>", "Set the mode for just this session (repeatable; a unique prefix is enough)"]],
  async run(args) {
    const config = loadConfig()
    const given = args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "--session") as Mode | undefined
    const ids = sessionArgs(args)
    if (given) {
      if (!MODES.includes(given)) fail(`Unknown mode: ${given}`, `Choose ${MODES.join(", ")}.`)
      applyMode(given, ids)
      return
    }
    const current = ids.length === 1 ? config.sessions[ids[0]]?.mode ?? config.mode : config.mode
    if (!interactive) {
      listModes(current)
      const own = Object.entries(config.sessions).filter(([, settings]) => settings.mode)
      if (own.length) {
        line()
        for (const [id, settings] of own) line(`  ${c.dim(shortId(id))}  ${settings.mode}`)
      }
      line()
      return
    }
    line()
    const chosen = await select(ids.length ? `Mode for ${ids.map(shortId).join(", ")}` : "Mode", MODES.map((value) => ({ value, hint: MODE_DESCRIPTIONS[value] })), current)
    if (chosen === null) return
    applyMode(chosen, ids)
  },
}
