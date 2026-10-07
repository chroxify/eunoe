import { VERSION } from "../version"
import { GLOBAL_OPTIONS, TAGLINE } from "./constants"
import { withLogo } from "./logo"
import type { Command } from "./types"
import { c, line } from "./ui"

export function printHelp(commands: Record<string, Command>) {
  const width = Math.max(...Object.keys(commands).map((name) => name.length), ...GLOBAL_OPTIONS.map(([flag]) => flag.length))
  line()
  for (const row of withLogo([`${c.bold("eunoe")} ${c.dim(VERSION)}`, c.italic(TAGLINE)])) line(row)
  line()
  line(`  ${c.dim("Usage")}`)
  line(`    eunoe ${c.cyan("<command>")} ${c.dim("[options]")}`)
  line()
  line(`  ${c.dim("Commands")}`)
  for (const [name, command] of Object.entries(commands).filter(([, command]) => !command.hidden)) line(`    ${c.cyan(name.padEnd(width))}   ${command.summary}`)
  line()
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
