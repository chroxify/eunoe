export type OptionRow = [flag: string, description: string]

export interface Choice<T extends string = string> {
  value: T
  label?: string
  hint?: string
}
