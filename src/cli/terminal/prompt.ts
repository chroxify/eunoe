import { c, useColor } from "./ui"

const ESC = "\x1b"
const KEY_SEQUENCE = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z~]|${ESC}.|[\\s\\S]`, "g")

interface Choice<T extends string = string> {
  value: T
  label?: string
  hint?: string
}

export const keys = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: ["\r", "\n"],
  escape: ["\x1b", "\x03"],
  backspace: ["\x7f", "\b"],
  clear: "\x15",
}

export const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)

export const printable = (key: string) => key >= " " && !key.startsWith("\x1b")

function readKeys(onKey: (key: string) => boolean | undefined): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    const handler = (chunk: string) => {
      for (const key of chunk.match(KEY_SEQUENCE) ?? []) {
        if (onKey(key) !== true) continue
        stdin.off("data", handler)
        stdin.setRawMode(false)
        stdin.pause()
        resolve()
        return
      }
    }
    stdin.on("data", handler)
  })
}

export async function interact(render: () => string[], onKey: (key: string) => boolean | undefined, hideCursor = true): Promise<void> {
  let drawn = 0
  const draw = () => {
    const lines = render()
    if (drawn) process.stdout.write(`\x1b[${drawn}A\x1b[J`)
    process.stdout.write(`${lines.join("\n")}\n`)
    drawn = lines.length
  }
  const toggleCursor = hideCursor && useColor
  if (toggleCursor) process.stdout.write("\x1b[?25l")
  draw()
  await readKeys((key) => {
    if (onKey(key) === true) return true
    draw()
  })
  process.stdout.write(`\x1b[${drawn}A\x1b[J`)
  if (toggleCursor) process.stdout.write("\x1b[?25h")
}

function renderChoices(title: string, choices: Choice[], index: number, width: number) {
  const lines = [`  ${c.bold(title)}`, ""]
  for (const [i, choice] of choices.entries()) {
    const label = (choice.label ?? choice.value).padEnd(width)
    const marker = i === index ? c.green("●") : c.dim("○")
    lines.push(`  ${marker} ${i === index ? c.bold(label) : label}${choice.hint ? `  ${c.dim(choice.hint)}` : ""}`)
  }
  lines.push("", `  ${c.dim("↑↓ move · enter choose · esc cancel")}`)
  return lines
}

export async function select<T extends string>(title: string, choices: Choice<T>[], current?: T): Promise<T | null> {
  let index = Math.max(
    0,
    choices.findIndex((choice) => choice.value === current),
  )
  const width = Math.max(...choices.map((choice) => (choice.label ?? choice.value).length))
  let chosen: T | null = null
  await interact(
    () => renderChoices(title, choices, index, width),
    (key) => {
      if (key === keys.up || key === "k") index = (index + choices.length - 1) % choices.length
      else if (key === keys.down || key === "j") index = (index + 1) % choices.length
      else if (keys.enter.includes(key)) {
        chosen = choices[index].value
        return true
      } else if (keys.escape.includes(key) || key === "q") return true
    },
  )
  return chosen
}

export async function input(title: string, placeholder: string, initial = ""): Promise<string | null> {
  let value = initial
  let result: string | null = null
  const render = () => [`  ${c.bold(title)}`, `  ${c.cyan("›")} ${value || c.dim(placeholder)}`, "", `  ${c.dim("enter save · esc cancel")}`]
  await interact(
    render,
    (key) => {
      if (keys.enter.includes(key)) {
        result = value
        return true
      }
      if (keys.escape.includes(key)) return true
      if (keys.backspace.includes(key)) value = value.slice(0, -1)
      else if (printable(key)) value += key
    },
    false,
  )
  return result
}
