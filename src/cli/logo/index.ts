import { HALF_BLOCKS, OCTANT_TERMINALS, OCTANTS, TRANSPARENT_PIXEL } from "../constants"
import { trueColor, useColor } from "../ui"
import { LOGO_KEYS, LOGO_PALETTE, LOGO_PIXELS } from "./pixels"

type Rgb = [number, number, number]
type Pixel = Rgb | null

const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb

const toCube = (value: number) => (value < 48 ? 0 : value < 115 ? 1 : Math.min(5, Math.round((value - 35) / 40)))

const MISMATCH = 3 * 255 ** 2

function sgr(color: Rgb, layer: "fg" | "bg") {
  const base = layer === "fg" ? 38 : 48
  if (trueColor) return `${base};2;${color.join(";")}`
  const [r, g, b] = color.map(toCube)
  return `${base};5;${16 + 36 * r + 6 * g + b}`
}

function pixel(key: string | undefined): Pixel {
  if (!key || key === TRANSPARENT_PIXEL) return null
  return rgb(LOGO_PALETTE[LOGO_KEYS.indexOf(key)])
}

function distance(a: Pixel, b: Pixel) {
  if (!a || !b) return a === b ? 0 : MISMATCH
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}

function split(block: Pixel[]): [Pixel, Pixel] {
  const colors = block.filter((color, i) => block.findIndex((other) => distance(other, color) === 0) === i)
  if (colors.length <= 2) return [colors[0] ?? null, colors[1] ?? null]
  let best: [Pixel, Pixel] = [colors[0], colors[1]]
  let bestError = Number.POSITIVE_INFINITY
  for (let i = 0; i < colors.length; i += 1) {
    for (let j = i + 1; j < colors.length; j += 1) {
      const error = block.reduce((total, color) => total + Math.min(distance(color, colors[i]), distance(color, colors[j])), 0)
      if (error < bestError) [best, bestError] = [[colors[i], colors[j]], error]
    }
  }
  return best
}

function dominant(block: Pixel[]): Pixel {
  const counts = block.map((color) => block.filter((other) => distance(other, color) === 0).length)
  return block[counts.indexOf(Math.max(...counts))]
}

function cell(block: Pixel[], glyphs: string[]) {
  let [fg, bg] = split(block)
  if (!fg) [fg, bg] = [bg, fg]
  if (!fg) return " "
  const mask = block.reduce((bits, color, i) => (distance(color, fg) <= distance(color, bg) ? bits | (1 << i) : bits), 0)
  const codes = bg ? `${sgr(fg, "fg")};${sgr(bg, "bg")}` : sgr(fg, "fg")
  return `\x1b[${codes}m${glyphs[mask]}\x1b[0m`
}

function supportsOctants() {
  const terminal = `${process.env.TERM_PROGRAM ?? ""} ${process.env.TERM ?? ""}`.toLowerCase()
  return OCTANT_TERMINALS.some((name) => terminal.includes(name))
}

function region(x: number, y: number, width: number, height: number): Pixel[] {
  const block: Pixel[] = []
  for (let dy = 0; dy < height; dy += 1) for (let dx = 0; dx < width; dx += 1) block.push(pixel(LOGO_PIXELS[y + dy]?.[x + dx]))
  return block
}

export function logoLines(): string[] {
  if (!useColor) return []
  const octants = supportsOctants()
  const lines: string[] = []
  for (let y = 0; y < LOGO_PIXELS.length; y += 4) {
    let row = ""
    for (let x = 0; x < LOGO_PIXELS[0].length; x += 2) {
      row += octants
        ? cell(region(x, y, 2, 4), OCTANTS)
        : cell([dominant(region(x, y, 2, 2)), dominant(region(x, y + 2, 2, 2))], [...HALF_BLOCKS])
    }
    lines.push(row)
  }
  return lines
}

export function withLogo(text: string[]): string[] {
  const logo = logoLines()
  return [...logo.map((row) => `  ${row}`), ...(logo.length ? [""] : []), ...text.map((entry) => `  ${entry}`)]
}
