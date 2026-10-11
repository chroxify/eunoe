import { CURSOR_HIDE, CURSOR_SHOW, KEY_BACKSPACE, KEY_DOWN, KEY_ENTER, KEY_ESCAPE, KEY_SEQUENCE, KEY_UP, VIM_DOWN, VIM_QUIT, VIM_UP } from "./constants"
import type { Choice } from "./types"
import { c, useColor } from "./ui"

export const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)

export const printable = (key: string) => key >= " " && !key.startsWith("\x1b")

function keys(onKey: (key: string) => boolean | undefined): Promise<void> {
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
  if (hideCursor && useColor) process.stdout.write(CURSOR_HIDE)
  draw()
  await keys((key) => {
    if (onKey(key) === true) return true
    draw()
  })
  process.stdout.write(`\x1b[${drawn}A\x1b[J`)
  if (hideCursor && useColor) process.stdout.write(CURSOR_SHOW)
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
      if (key === KEY_UP || key === VIM_UP) index = (index + choices.length - 1) % choices.length
      else if (key === KEY_DOWN || key === VIM_DOWN) index = (index + 1) % choices.length
      else if (KEY_ENTER.includes(key)) {
        chosen = choices[index].value
        return true
      } else if (KEY_ESCAPE.includes(key) || key === VIM_QUIT) return true
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
      if (KEY_ENTER.includes(key)) {
        result = value
        return true
      }
      if (KEY_ESCAPE.includes(key)) return true
      if (KEY_BACKSPACE.includes(key)) value = value.slice(0, -1)
      else if (printable(key)) value += key
    },
    false,
  )
  return result
}
