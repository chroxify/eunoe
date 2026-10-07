import type { Command } from "../types"
import { disable } from "./disable"
import { enable } from "./enable"
import { mode } from "./mode"
import { serve } from "./serve"
import { status } from "./status"
import { uninstall } from "./uninstall"

export const commands: Record<string, Command> = { enable, disable, mode, status, uninstall, serve }
