#!/usr/bin/env bun
import { VERSION } from "../version"
import { wantsHelp } from "./args"
import { commands } from "./commands"
import { printCommandHelp, printHelp } from "./help"
import { closest, fail, line } from "./ui"

const [name, ...args] = process.argv.slice(2)

if (!name || name === "help" || name === "-h" || name === "--help") {
  const topic = name === "help" ? args[0] : undefined
  if (topic && commands[topic]) printCommandHelp(topic, commands[topic])
  else printHelp(commands)
} else if (name === "-v" || name === "--version" || name === "version") {
  line(VERSION)
} else if (!commands[name]) {
  const suggestion = closest(name, Object.keys(commands))
  fail(`Unknown command: ${name}`, suggestion ? `Did you mean \`eunoe ${suggestion}\`?` : "Run `eunoe --help` to see the commands.")
} else if (wantsHelp(args)) {
  printCommandHelp(name, commands[name])
} else {
  await commands[name].run(args)
}
