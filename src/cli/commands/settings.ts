import { loadConfig, overrides, parseTunable, saveConfig } from "../../config"
import { DEFAULTS, TUNABLES } from "../../config/constants"
import type { Tunable } from "../../config/types"
import { TUNABLE_DESCRIPTIONS, TUNABLE_HINTS } from "../constants"
import { input, interactive, select } from "../prompt"
import { sessionArgs, shortId } from "../sessions"
import type { Command } from "../types"
import { c, fail, line, ok, rows } from "../ui"

const RESET = "default"

function listSettings() {
  const config = loadConfig()
  line()
  const width = Math.max(...TUNABLES.map((name) => String(config[name]).length))
  rows(TUNABLES.map((name) => {
    const value = String(config[name])
    const changed = config[name] !== DEFAULTS[name]
    return [name, `${c.bold(value.padEnd(width))}  ${c.dim(TUNABLE_DESCRIPTIONS[name])}${changed ? c.dim(`  (default ${DEFAULTS[name]})`) : ""}`]
  }))
  const own = Object.entries(config.sessions).map(([id, settings]) => [id, overrides(settings)] as const).filter(([, values]) => Object.keys(values).length)
  if (own.length) {
    line()
    for (const [id, values] of own) line(`  ${c.cyan(shortId(id))}  ${Object.entries(values).map(([name, value]) => `${name} ${c.bold(String(value))}`).join(c.dim("  ·  "))}`)
  }
  line()
}

function applySetting(name: Tunable, raw: string, ids: string[]) {
  const config = loadConfig()
  if (raw === RESET) {
    if (!ids.length) fail(`\`${RESET}\` only applies with --session`, `eunoe settings set ${name} ${RESET} --session <id>`)
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
    if (config.scope === "sessions" && ids.some((id) => !config.sessions[id])) line(`  ${c.dim("eunoe only manages sessions you started it for: eunoe start --session <id>")}`)
    return
  }
  saveConfig({ [name]: value })
  ok(`${name} ${c.bold(String(value))}`)
}

async function pickSetting(ids: string[]) {
  const config = loadConfig()
  line()
  const name = await select<Tunable>(ids.length ? `Setting for ${ids.map(shortId).join(", ")}` : "Setting", TUNABLES.map((value) => ({ value, hint: `${String(config[value]).padEnd(12)} ${TUNABLE_DESCRIPTIONS[value]}` })))
  if (name === null) return
  const current = ids.length === 1 ? config.sessions[ids[0]]?.[name] ?? config[name] : config[name]
  const raw = await input(`${name}  ${c.dim(TUNABLE_HINTS[name])}`, `${current}  (current)`)
  if (raw === null || raw === "") return
  applySetting(name, raw, ids)
}

export const settings: Command = {
  summary: "List or change settings, for every session or just one",
  usage: "eunoe settings [list | set <key> <value>] [--session <id>]",
  details: [
    "Without arguments it opens a picker. Keys:",
    ...TUNABLES.map((key) => `  ${key.padEnd(10)} ${TUNABLE_DESCRIPTIONS[key]} ${c.dim(`(${TUNABLE_HINTS[key]})`)}`),
    "",
    `With --session, the value applies to that session only; \`${RESET}\` removes its own value.`,
    "Takes effect on the next request; no restart needed.",
  ],
  options: [["--session <id>", "Change it for just this session (repeatable; a unique prefix is enough)"]],
  async run(args) {
    const words = args.filter((arg, i) => !arg.startsWith("-") && args[i - 1] !== "--session")
    const ids = sessionArgs(args)
    const [verb, key, raw] = words
    if (!verb) {
      if (interactive) await pickSetting(ids)
      else listSettings()
      return
    }
    if (verb === "list") {
      listSettings()
      return
    }
    if (verb !== "set") fail(`Unknown subcommand: ${verb}`, "Use `eunoe settings list` or `eunoe settings set <key> <value>`.")
    if (!key) {
      if (interactive) await pickSetting(ids)
      else fail("set needs a key and a value", "eunoe settings set <key> <value>")
      return
    }
    if (!TUNABLES.includes(key as Tunable)) fail(`Unknown setting: ${key}`, `Choose ${TUNABLES.join(", ")}.`)
    if (raw === undefined) fail(`${key} needs a value`, `eunoe settings set ${key} <${TUNABLE_HINTS[key as Tunable]}>`)
    applySetting(key as Tunable, raw, ids)
  },
}
