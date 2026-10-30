import { compactionOwner, MODES, readConfig, saveConfig } from "../../config"
import type { Mode } from "../../core/config"
import type { Command } from "../command"
import { editSettings, withCompactionOwner } from "../proxy/claude-settings"
import { routedDirs } from "../proxy/inspect"
import { isKnown, sessionArgs, shortId } from "../sessions"
import { interactive, select } from "../terminal/prompt"
import { c, fail, line, note, ok, warn } from "../terminal/ui"

export const MODE_DESCRIPTIONS: Record<Mode, string> = {
  default: "Recent turns whole, older turns folded; evidence and recall on",
  compact: "Claude Code as it is, only its compaction replaced",
  off: "Passthrough; Claude Code compacts on its own",
}

function listModes(current: Mode) {
  line()
  for (const name of MODES) {
    const active = name === current
    line(`  ${active ? c.green("●") : c.dim("○")} ${active ? c.bold(name.padEnd(8)) : name.padEnd(8)}  ${c.dim(MODE_DESCRIPTIONS[name])}`)
  }
}

function applyMode(next: Mode, ids: string[]) {
  const config = readConfig()
  if (ids.length > 0) {
    saveConfig({ sessions: { ...config.sessions, ...Object.fromEntries(ids.map((id) => [id, { ...config.sessions[id], mode: next }])) } })
    ok(`Mode ${c.bold(next)} for ${ids.map(shortId).join(", ")}  ${c.dim(MODE_DESCRIPTIONS[next])}`)
    if (routedDirs(config).length === 0) warn("Claude Code isn't routed through eunoe. Run `eunoe start --session <id>`.")
    const unseen = ids.filter((id) => !isKnown(id))
    if (unseen.length > 0) note(`Not seen through eunoe yet: ${unseen.map(shortId).join(", ")}. Check the id in Claude Code's /status.`)
    return
  }
  saveConfig({ mode: next })
  const updated = readConfig()
  editSettings(routedDirs(updated), (settings) => withCompactionOwner(settings, compactionOwner(updated)))
  ok(`Mode ${c.bold(next)}  ${c.dim(MODE_DESCRIPTIONS[next])}`)
}

function printModes(current: Mode) {
  const config = readConfig()
  listModes(current)
  const own = Object.entries(config.sessions).filter(([, settings]) => settings.mode)
  if (own.length > 0) {
    line()
    for (const [id, settings] of own) line(`  ${c.dim(shortId(id))}  ${settings.mode}`)
  }
  line()
}

export const mode: Command = {
  summary: "Pick how eunoe manages context",
  usage: "eunoe mode [default | compact | off] [--session <id>]",
  details: ["Without a mode it opens a picker. Takes effect on the next request; no restart needed."],
  options: [["--session <id>", "Set the mode for just this session (repeatable; a unique prefix is enough)"]],
  async run(args) {
    const config = readConfig()
    const given = args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "--session")
    const ids = sessionArgs(args)
    if (given) {
      if (!MODES.includes(given as Mode)) fail(`Unknown mode: ${given}`, `Choose ${MODES.join(", ")}.`)
      applyMode(given as Mode, ids)
      return
    }
    const current = ids.length === 1 ? (config.sessions[ids[0]]?.mode ?? config.mode) : config.mode
    if (!interactive) return printModes(current)
    line()
    const chosen = await select(
      ids.length > 0 ? `Mode for ${ids.map(shortId).join(", ")}` : "Mode",
      MODES.map((value) => ({ value, hint: MODE_DESCRIPTIONS[value] })),
      current,
    )
    if (chosen !== null) applyMode(chosen, ids)
  },
}
