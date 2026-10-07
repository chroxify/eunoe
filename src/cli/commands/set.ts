import { loadConfig, overrides, parseTunable, saveConfig } from "../../config"
import { TUNABLES } from "../../config/constants"
import type { Tunable } from "../../config/types"
import { TUNABLE_DESCRIPTIONS, TUNABLE_HINTS } from "../constants"
import { sessionArgs, shortId } from "../sessions"
import type { Command } from "../types"
import { c, fail, line, ok, rows } from "../ui"

const RESET = "default"

export const set: Command = {
  summary: "Show or change a setting, for every session or just one",
  usage: "eunoe set [<key> <value>] [--session <id>]",
  details: [
    "Keys:",
    ...TUNABLES.map((key) => `  ${key.padEnd(10)} ${TUNABLE_DESCRIPTIONS[key]} ${c.dim(`(${TUNABLE_HINTS[key]})`)}`),
    "",
    `With --session, the value applies to that session only; \`${RESET}\` removes its own value.`,
    "Takes effect on the next request; no restart needed.",
  ],
  options: [["--session <id>", "Change it for just this session (repeatable; a unique prefix is enough)"]],
  run(args) {
    const config = loadConfig()
    const [key, raw] = args.filter((arg, i) => !arg.startsWith("-") && args[i - 1] !== "--session")
    const ids = sessionArgs(args)

    if (!key) {
      line()
      const width = Math.max(...TUNABLES.map((name) => String(config[name]).length))
      rows(TUNABLES.map((name) => [name, `${c.bold(String(config[name]).padEnd(width))}  ${c.dim(TUNABLE_DESCRIPTIONS[name])}`]))
      const own = Object.entries(config.sessions).map(([id, settings]) => [id, overrides(settings)] as const).filter(([, values]) => Object.keys(values).length)
      if (own.length) {
        line()
        for (const [id, values] of own) line(`  ${c.cyan(shortId(id))}  ${Object.entries(values).map(([name, value]) => `${name} ${c.bold(String(value))}`).join(c.dim("  ·  "))}`)
      }
      line()
      return
    }
    if (!TUNABLES.includes(key as Tunable)) fail(`Unknown setting: ${key}`, `Choose ${TUNABLES.join(", ")}.`)
    const name = key as Tunable
    if (raw === undefined) fail(`${name} needs a value`, `eunoe set ${name} <${TUNABLE_HINTS[name]}>`)

    if (raw === RESET) {
      if (!ids.length) fail(`\`${RESET}\` only applies with --session`, `eunoe set ${name} ${RESET} --session <id>`)
      const sessions = { ...config.sessions }
      for (const id of ids) {
        if (!sessions[id]) continue
        const { [name]: _, ...rest } = sessions[id]
        sessions[id] = rest
      }
      saveConfig({ sessions })
      ok(`${name} back to the default (${c.bold(String(config[name]))}) for ${ids.map(shortId).join(", ")}`)
      return
    }

    const value = parseTunable(name, raw)
    if (value === null) fail(`Not a valid ${name}: ${raw}`, `Expected ${TUNABLE_HINTS[name]}.`)
    if (ids.length) {
      saveConfig({ sessions: { ...config.sessions, ...Object.fromEntries(ids.map((id) => [id, { ...config.sessions[id], [name]: value }])) } })
      ok(`${name} ${c.bold(String(value))} for ${ids.map(shortId).join(", ")}`)
      if (config.scope === "sessions" && ids.some((id) => !config.sessions[id])) line(`  ${c.dim("eunoe only manages sessions you enabled: eunoe enable --session <id>")}`)
      return
    }
    saveConfig({ [name]: value })
    ok(`${name} ${c.bold(String(value))}`)
  },
}
