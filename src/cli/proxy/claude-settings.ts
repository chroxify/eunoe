import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { BLOCKING_LIMIT_ENV, BLOCKING_LIMIT_OFF } from "./constants"
import type { Settings } from "./types"

export const proxyUrl = (port: number) => `http://127.0.0.1:${port}`

export const pointsAtEunoe = (settings: Settings, port: number) => settings.env?.ANTHROPIC_BASE_URL === proxyUrl(port)

export function withEunoe(settings: Settings, port: number, mode: string): Settings {
  const next = { ...settings, env: { ...settings.env, ANTHROPIC_BASE_URL: proxyUrl(port) } }
  return withCompactionOwner(next, mode)
}

export function withoutEunoe(settings: Settings, port: number): Settings {
  const next = { ...settings }
  if (next.env && pointsAtEunoe(next, port)) {
    const { ANTHROPIC_BASE_URL: _, ...env } = next.env
    if (Object.keys(env).length > 0) next.env = env
    else delete next.env
  }
  return withCompactionOwner(next, "off")
}

export function withCompactionOwner(settings: Settings, mode: string): Settings {
  const next = { ...settings }
  if (mode === "off") {
    delete next.autoCompactEnabled
    if (next.env?.[BLOCKING_LIMIT_ENV] === BLOCKING_LIMIT_OFF) {
      const { [BLOCKING_LIMIT_ENV]: _, ...env } = next.env
      if (Object.keys(env).length > 0) next.env = env
      else delete next.env
    }
  } else {
    next.autoCompactEnabled = false
    next.env = { ...next.env, [BLOCKING_LIMIT_ENV]: BLOCKING_LIMIT_OFF }
  }
  return next
}

export function editSettings(dirs: string[], edit: (settings: Settings) => Settings): string[] {
  const touched: string[] = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const file = path.join(dir, "settings.json")
    const current: Settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
    const next = edit(current)
    if (JSON.stringify(next) === JSON.stringify(current)) continue
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
    touched.push(file)
  }
  return touched
}
