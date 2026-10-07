export type Settings = Record<string, any>

export type OptionRow = [flag: string, description: string]

export interface Command {
  summary: string
  usage: string
  details?: string[]
  options?: OptionRow[]
  hidden?: boolean
  run: (args: string[]) => void | Promise<void>
}

export type RequestRecord = Record<string, any>
