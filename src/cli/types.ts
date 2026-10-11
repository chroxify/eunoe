import type { OptionRow } from "./terminal/types"

export interface Command {
  summary: string
  usage: string
  details?: string[]
  options?: OptionRow[]
  hidden?: boolean
  run: (args: string[]) => void | Promise<void>
}
