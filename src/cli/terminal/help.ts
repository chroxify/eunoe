import { VERSION } from "../../constants"
import { withLogo } from "../logo"
import type { Command } from "../types"
import { COMMAND_GROUPS, GLOBAL_OPTIONS, TAGLINE } from "./constants"
import { c, line } from "./ui"

export function printHelp(commands: Record<string, Command>) {
  const width = Math.max(...Object.keys(commands).map((name) => name.length), ...GLOBAL_OPTIONS.map(([flag]) => flag.length))
  line()
  for (const row of withLogo([`${c.bold("eunoe")} ${c.dim(VERSION)}`, c.italic(TAGLINE)])) line(row)
  line()
  line(`  ${c.dim("Usage")}`)
  line(`    eunoe ${c.cyan("<command>")} ${c.dim("[options]")}`)
  line()
  const visible = Object.keys(commands).filter((name) => !commands[name].hidden)
  const grouped = new Set(COMMAND_GROUPS.flatMap(([, names]) => names))
  const groups = [...COMMAND_GROUPS, ["Other", visible.filter((name) => !grouped.has(name))] as [string, string[]]]
  for (const [title, names] of groups) {
    const shown = names.filter((name) => visible.includes(name))
    if (shown.length === 0) continue
    line(`  ${c.dim(title)}`)
    for (const name of shown) line(`    ${c.cyan(name.padEnd(width))}   ${commands[name].summary}`)
    line()
  }
  line(`  ${c.dim("Options")}`)
  for (const [flag, description] of GLOBAL_OPTIONS) line(`    ${flag.padEnd(width)}   ${description}`)
  line()
  line(`  ${c.dim("Run")} eunoe ${c.cyan("<command>")} --help ${c.dim("for details.")} ${c.dim("`ee` works anywhere `eunoe` does.")}`)
  line()
}

export function printCommandHelp(name: string, command: Command) {
  line()
  line(`  ${c.bold(`eunoe ${name}`)}  ${c.dim(command.summary)}`)
  line()
  line(`  ${c.dim("Usage")}`)
  line(`    ${command.usage}`)
  if (command.details) {
    line()
    for (const detail of command.details) line(`  ${detail}`)
  }
  if (command.options) {
    line()
    line(`  ${c.dim("Options")}`)
    const width = Math.max(...command.options.map(([flag]) => flag.length))
    for (const [flag, description] of command.options) line(`    ${c.cyan(flag.padEnd(width))}   ${description}`)
  }
  line()
}
