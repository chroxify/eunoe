import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { EUNOE_DIR, paths } from "../config/constants"
import { ANTHROPIC_VERSION, MODEL_HEADERS, MODEL_LOOKUP_TIMEOUT_MS } from "./constants"

const CACHE = paths.models

function readCache(): Map<string, number> {
  try {
    return new Map(existsSync(CACHE) ? Object.entries(JSON.parse(readFileSync(CACHE, "utf8"))) : [])
  } catch {
    return new Map()
  }
}

const windows = readCache()
const lookups = new Map<string, Promise<number | null>>()

function modelId(model: unknown) {
  return String(model ?? "").replace(/\[[^\]]*\]$/, "")
}

export async function resolveWindow(model: unknown, requestHeaders: Headers, upstream: string): Promise<number | null> {
  const id = modelId(model)
  if (!id) return null
  const known = windows.get(id)
  if (known) return known
  let lookup = lookups.get(id)
  if (!lookup) {
    const headers = new Headers()
    for (const name of MODEL_HEADERS) {
      const value = requestHeaders.get(name)
      if (value) headers.set(name, value)
    }
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", ANTHROPIC_VERSION)
    lookup = fetch(`${upstream}/v1/models/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(MODEL_LOOKUP_TIMEOUT_MS) })
      .then(async (response) => {
        if (!response.ok) return null
        const info = await response.json() as { max_input_tokens?: number }
        if (typeof info.max_input_tokens !== "number" || info.max_input_tokens <= 0) return null
        windows.set(id, info.max_input_tokens)
        mkdirSync(EUNOE_DIR, { recursive: true })
        writeFileSync(CACHE, JSON.stringify(Object.fromEntries(windows), null, 2))
        return info.max_input_tokens
      })
      .catch(() => null)
      .finally(() => lookups.delete(id))
    lookups.set(id, lookup)
  }
  return lookup
}
