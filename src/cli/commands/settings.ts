import { DEFAULTS, overrides, parseTunable, readConfig, saveConfig, TUNABLES, type Tunable } from "../../config"
import type { Command } from "../command"
import { sessionArgs, shortId } from "../sessions"
import { input, interactive, select } from "../terminal/prompt"
import { c, fail, line, ok, rows } from "../terminal/ui"

const DESCRIPTIONS: Record<Tunable, string> = {
  keep: "Turns kept whole at the end, in default mode",
  budget: "Tokens of older detail that trigger a fold, in default mode",
  turnCap: "A kept turn larger than this many tokens is folded at once, live turn excepted; or off",
  compactAt: "Share of the context window that triggers the cut",
  keepTurns: "Earlier turns kept after a cut",
  search: "How transcripts are written for the agent to search",
  rerank: "Typesafe model that reorders recall, or off",
}

const HINTS: Record<Tunable, string> = {
  keep: "a whole number, 1 or more",
  budget: "a token count, 1000 or more",
  turnCap: "a token count, 1000 or more, or off",
  compactAt: "a number above 0, up to 1",
  keepTurns: "a whole number or all",
  search: "markdown, xml, jsonl or qmd",
  rerank: "a model name such as jev-preview, or off",
}

const RESET = "default"

const forSessions = (ids: string[]) => ids.map(shortId).join(", ")

function listSettings() {
  const config = readConfig()
  line()
  const width = Math.max(...TUNABLES.map((name) => String(config[name]).length))
  rows(
    TUNABLES.map((name) => {
      const changed = config[name] !== DEFAULTS[name]
      return [name, `${c.bold(String(config[name]).padEnd(width))}  ${c.dim(DESCRIPTIONS[name])}${changed ? c.dim(`  (default ${DEFAULTS[name]})`) : ""}`]
    }),
  )
  const own = Object.entries(config.sessions)
    .map(([id, session]) => [id, overrides(session)] as const)
    .filter(([, values]) => Object.keys(values).length > 0)
  if (own.length > 0) {
    line()
    for (const [id, values] of own) {
      const shown = Object.entries(values).map(([name, value]) => `${name} ${c.bold(String(value))}`)
      line(`  ${c.cyan(shortId(id))}  ${shown.join(c.dim("  ·  "))}`)
    }
  }
  line()
}

function resetSetting(name: Tunable, ids: string[]) {
  const config = readConfig()
  if (ids.length === 0) fail(`\`${RESET}\` only applies with --session`, `eunoe settings set ${name} ${RESET} --session <id>`)
  const sessions = { ...config.sessions }
  for (const id of ids) {
    if (!sessions[id]) continue
    const { [name]: _, ...rest } = sessions[id]
    sessions[id] = rest
  }
  saveConfig({ sessions })
  ok(`${name} back to the default (${c.bold(String(config[name]))}) for ${forSessions(ids)}`)
}

function applySetting(name: Tunable, raw: string, ids: string[]) {
  if (raw === RESET) return resetSetting(name, ids)
  const config = readConfig()
  const value = parseTunable(name, raw)
  if (value === null) fail(`Not a valid ${name}: ${raw}`, `Expected ${HINTS[name]}.`)
  if (ids.length === 0) {
    saveConfig({ [name]: value })
    ok(`${name} ${c.bold(String(value))}`)
    return
  }
  saveConfig({ sessions: { ...config.sessions, ...Object.fromEntries(ids.map((id) => [id, { ...config.sessions[id], [name]: value }])) } })
  ok(`${name} ${c.bold(String(value))} for ${forSessions(ids)}`)
  if (config.scope === "sessions" && ids.some((id) => !config.sessions[id])) line(`  ${c.dim("eunoe only manages sessions you started it for: eunoe start --session <id>")}`)
}

async function pickSetting(ids: string[]) {
  const config = readConfig()
  line()
  const name = await select<Tunable>(
    ids.length > 0 ? `Setting for ${forSessions(ids)}` : "Setting",
    TUNABLES.map((value) => ({ value, hint: `${String(config[value]).padEnd(12)} ${DESCRIPTIONS[value]}` })),
  )
  if (name === null) return
  const current = ids.length === 1 ? (config.sessions[ids[0]]?.[name] ?? config[name]) : config[name]
  const raw = await input(`${name}  ${c.dim(HINTS[name])}`, `${current}  (current)`)
  if (raw) applySetting(name, raw, ids)
}

export const settings: Command = {
  summary: "List or change settings, for every session or just one",
  usage: "eunoe settings [list | set <key> <value>] [--session <id>]",
  details: [
    "Without arguments it opens a picker. Keys:",
    ...TUNABLES.map((key) => `  ${key.padEnd(10)} ${DESCRIPTIONS[key]} ${c.dim(`(${HINTS[key]})`)}`),
    "",
    `With --session, the value applies to that session only; \`${RESET}\` removes its own value.`,
    "Takes effect on the next request; no restart needed.",
  ],
  options: [["--session <id>", "Change it for just this session (repeatable; a unique prefix is enough)"]],
  run(args) {
    const [verb, key, raw] = args.filter((arg, i) => !arg.startsWith("-") && args[i - 1] !== "--session")
    const ids = sessionArgs(args)
    if (verb === "list" || (!verb && !interactive)) return listSettings()
    if (verb && verb !== "set") fail(`Unknown subcommand: ${verb}`, "Use `eunoe settings list` or `eunoe settings set <key> <value>`.")
    if (!key) {
      if (!interactive) fail("set needs a key and a value", "eunoe settings set <key> <value>")
      return pickSetting(ids)
    }
    if (!TUNABLES.includes(key as Tunable)) fail(`Unknown setting: ${key}`, `Choose ${TUNABLES.join(", ")}.`)
    if (raw === undefined) fail(`${key} needs a value`, `eunoe settings set ${key} <${HINTS[key as Tunable]}>`)
    applySetting(key as Tunable, raw, ids)
  },
}
