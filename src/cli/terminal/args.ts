import { fail } from "./ui"

export function flagValues(args: string[], flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== flag) continue
    const value = args[i + 1]
    if (!value || value.startsWith("-")) fail(`${flag} needs a value`)
    values.push(value)
    i += 1
  }
  return values
}

export function wantsHelp(args: string[]) {
  return args.includes("--help") || args.includes("-h")
}
