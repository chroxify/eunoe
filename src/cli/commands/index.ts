import type { Command } from "../types"
import { mode } from "./mode"
import { serve } from "./serve"
import { settings } from "./settings"
import { start } from "./start"
import { status } from "./status"
import { stop } from "./stop"
import { uninstall } from "./uninstall"

const alias = (target: Command, prefix: string[] = []): Command => ({ ...target, hidden: true, run: (args) => target.run([...prefix, ...args]) })

export const commands: Record<string, Command> = {
  start,
  stop,
  mode,
  settings,
  status,
  uninstall,
  serve,
  enable: alias(start),
  disable: alias(stop),
  set: alias(settings, ["set"]),
}
