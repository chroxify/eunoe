import { homedir } from "node:os"
import { TYPO_DISTANCE } from "./constants"

const colorFor = (stream: NodeJS.WriteStream) => Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb"
export const useColor = colorFor(process.stdout)
export const trueColor = /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? "")
const useColorErr = colorFor(process.stderr)

const paint = (open: number, close: number, enabled = useColor) => (text: string) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text)

export const c = {
  bold: paint(1, 22),
  dim: paint(2, 22),
  italic: paint(3, 23),
  cyan: paint(36, 39),
  green: paint(32, 39),
  yellow: paint(33, 39),
  red: paint(31, 39),
  magenta: paint(35, 39),
}

const errRed = paint(31, 39, useColorErr)
const errDim = paint(2, 22, useColorErr)

export function line(text = "") {
  console.log(text)
}

export function ok(text: string) {
  console.log(`${c.green("✓")} ${text}`)
}

export function note(text: string) {
  console.log(`${c.dim("·")} ${text}`)
}

export function warn(text: string) {
  console.log(`${c.yellow("!")} ${text}`)
}

export function fail(text: string, hint?: string): never {
  console.error(`${errRed("✗")} ${text}`)
  if (hint) console.error(`  ${errDim(hint)}`)
  process.exit(1)
}

export function listFiles(files: string[]) {
  for (const file of files) line(`    ${c.dim(tilde(file))}`)
}

export function rows(entries: Array<[string, string]>, indent = 2) {
  const width = Math.max(...entries.map(([label]) => label.length))
  for (const [label, value] of entries) console.log(`${" ".repeat(indent)}${c.dim(label.padEnd(width))}  ${value}`)
}

export function tilde(file: string) {
  const home = homedir()
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file
}

export function tokens(count: number) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}k`
  return String(count)
}

export function ago(iso: string) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 60) return "just now"
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

export function closest(input: string, options: string[]) {
  const distance = (a: string, b: string) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i += 1) {
      let previous = row[0]
      row[0] = i
      for (let j = 1; j <= b.length; j += 1) {
        const current = row[j]
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
        previous = current
      }
    }
    return row[b.length]
  }
  const [best] = options.map((option) => [option, distance(input, option)] as const).sort((x, y) => x[1] - y[1])
  return best && best[1] <= TYPO_DISTANCE ? best[0] : null
}
