import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

export interface Settings {
  env?: Record<string, string>
  autoCompactEnabled?: boolean
  [key: string]: unknown
}

export const BLOCKING_LIMIT_ENV = "CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE"
export const BLOCKING_LIMIT_OFF = "1000000000"

export const proxyUrl = (port: number) => `http://127.0.0.1:${port}`

export const pointsAtEunoe = (settings: Settings, port: number) => settings.env?.ANTHROPIC_BASE_URL === proxyUrl(port)

function withoutEnv(settings: Settings, name: string): Settings {
  if (!settings.env || !(name in settings.env)) return settings
  const { [name]: _, ...env } = settings.env
  const next: Settings = { ...settings, env }
  if (Object.keys(env).length === 0) delete next.env
  return next
}

export function withCompactionOwner(settings: Settings, mode: string): Settings {
  if (mode !== "off") return { ...settings, autoCompactEnabled: false, env: { ...settings.env, [BLOCKING_LIMIT_ENV]: BLOCKING_LIMIT_OFF } }
  const { autoCompactEnabled: _, ...rest } = settings
  return rest.env?.[BLOCKING_LIMIT_ENV] === BLOCKING_LIMIT_OFF ? withoutEnv(rest, BLOCKING_LIMIT_ENV) : rest
}

export function withEunoe(settings: Settings, port: number, mode: string): Settings {
  return withCompactionOwner({ ...settings, env: { ...settings.env, ANTHROPIC_BASE_URL: proxyUrl(port) } }, mode)
}

export function withoutEunoe(settings: Settings, port: number): Settings {
  return withCompactionOwner(pointsAtEunoe(settings, port) ? withoutEnv(settings, "ANTHROPIC_BASE_URL") : settings, "off")
}

export function readSettings(dir: string): Settings {
  try {
    return JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"))
  } catch {
    return {}
  }
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
