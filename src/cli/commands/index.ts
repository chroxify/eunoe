import type { Command } from "../types"
import { install } from "./install"
import { mode } from "./mode"
import { serve } from "./serve"
import { status } from "./status"
import { stop } from "./stop"
import { uninstall } from "./uninstall"

export const commands: Record<string, Command> = { install, uninstall, stop, mode, status, serve }
