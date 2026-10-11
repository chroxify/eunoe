import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { EUNOE_DIR, paths } from "../config/paths"

function readCache(): Map<string, number> {
  try {
    return new Map(existsSync(paths.models) ? Object.entries(JSON.parse(readFileSync(paths.models, "utf8"))) : [])
  } catch {
    return new Map()
  }
}

const windows = readCache()
const lookups = new Map<string, Promise<number | null>>()

function lookupHeaders(requestHeaders: Headers): Headers {
  const headers = new Headers()
  for (const name of ["authorization", "x-api-key", "anthropic-version", "anthropic-beta"]) {
    const value = requestHeaders.get(name)
    if (value) headers.set(name, value)
  }
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
  return headers
}

async function lookup(id: string, requestHeaders: Headers, upstream: string): Promise<number | null> {
  const response = await fetch(`${upstream}/v1/models/${encodeURIComponent(id)}`, { headers: lookupHeaders(requestHeaders), signal: AbortSignal.timeout(5_000) })
  if (!response.ok) return null
  const info = (await response.json()) as { max_input_tokens?: number }
  if (typeof info.max_input_tokens !== "number" || info.max_input_tokens <= 0) return null
  windows.set(id, info.max_input_tokens)
  mkdirSync(EUNOE_DIR, { recursive: true })
  writeFileSync(paths.models, JSON.stringify(Object.fromEntries(windows), null, 2))
  return info.max_input_tokens
}

export function resolveWindow(model: unknown, requestHeaders: Headers, upstream: string): Promise<number | null> {
  const id = String(model ?? "").replace(/\[[^\]]*\]$/, "")
  if (!id) return Promise.resolve(null)
  const known = windows.get(id)
  if (known) return Promise.resolve(known)
  const inFlight = lookups.get(id)
  if (inFlight) return inFlight
  const pending = lookup(id, requestHeaders, upstream)
    .catch(() => null)
    .finally(() => lookups.delete(id))
  lookups.set(id, pending)
  return pending
}
