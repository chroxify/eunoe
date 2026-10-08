import { c, useColor } from "./ui"

export interface Choice<T extends string = string> {
  value: T
  label?: string
  hint?: string
}

export const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)

function keys(onKey: (key: string) => boolean | void): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    const handler = (chunk: string) => {
      if (onKey(chunk) === true) {
        stdin.off("data", handler)
        stdin.setRawMode(false)
        stdin.pause()
        resolve()
      }
    }
    stdin.on("data", handler)
  })
}

function render(title: string, choices: Choice[], index: number, width: number) {
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
  let index = Math.max(0, choices.findIndex((choice) => choice.value === current))
  const width = Math.max(...choices.map((choice) => (choice.label ?? choice.value).length))
  let drawn = 0
  const draw = () => {
    const lines = render(title, choices, index, width)
    if (drawn) process.stdout.write(`\x1b[${drawn}A\x1b[J`)
    process.stdout.write(lines.join("\n") + "\n")
    drawn = lines.length
  }
  let chosen: T | null = null
  process.stdout.write(useColor ? "\x1b[?25l" : "")
  draw()
  await keys((key) => {
    if (key === "\x1b[A" || key === "k") index = (index + choices.length - 1) % choices.length
    else if (key === "\x1b[B" || key === "j") index = (index + 1) % choices.length
    else if (key === "\r" || key === "\n") {
      chosen = choices[index].value
      return true
    } else if (key === "\x1b" || key === "q" || key === "\x03") return true
    draw()
  })
  process.stdout.write(`\x1b[${drawn}A\x1b[J`)
  process.stdout.write(useColor ? "\x1b[?25h" : "")
  return chosen
}

export async function input(title: string, placeholder: string, initial = ""): Promise<string | null> {
  let value = initial
  let drawn = 0
  const draw = () => {
    const shown = value ? value : c.dim(placeholder)
    const lines = [`  ${c.bold(title)}`, `  ${c.cyan("›")} ${shown}`, "", `  ${c.dim("enter save · esc cancel")}`]
    if (drawn) process.stdout.write(`\x1b[${drawn}A\x1b[J`)
    process.stdout.write(lines.join("\n") + "\n")
    drawn = lines.length
  }
  let result: string | null = null
  draw()
  await keys((key) => {
    if (key === "\r" || key === "\n") {
      result = value
      return true
    }
    if (key === "\x1b" || key === "\x03") return true
    if (key === "\x7f" || key === "\b") value = value.slice(0, -1)
    else if (key >= " " && !key.startsWith("\x1b")) value += key
    draw()
  })
  process.stdout.write(`\x1b[${drawn}A\x1b[J`)
  return result
}
