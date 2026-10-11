import type { Command } from "../types"
import { load } from "./load"
import { mode } from "./mode"
import { peek } from "./peek"
import { replay } from "./replay"
import { serve } from "./serve"
import { sessions } from "./sessions"
import { settings } from "./settings"
import { start } from "./start"
import { status } from "./status"
import { stop } from "./stop"
import { uninstall } from "./uninstall"
import { watch } from "./watch"

const alias = (target: Command, prefix: string[] = []): Command => ({ ...target, hidden: true, run: (args) => target.run([...prefix, ...args]) })

export const commands: Record<string, Command> = {
  start,
  stop,
  mode,
  settings,
  status,
  replay,
  sessions,
  peek,
  load,
  uninstall,
  serve,
  watch,
  enable: alias(start),
  disable: alias(stop),
  set: alias(settings, ["set"]),
}
