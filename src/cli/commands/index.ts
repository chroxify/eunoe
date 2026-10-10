import type { Command } from "../types"
import { continueSession } from "./continue"
import { load } from "./load"
import { mode } from "./mode"
import { peek } from "./peek"
import { serve } from "./serve"
import { sessions } from "./sessions"
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
  sessions,
  peek,
  load,
  continue: continueSession,
  uninstall,
  serve,
  enable: alias(start),
  disable: alias(stop),
  set: alias(settings, ["set"]),
}
