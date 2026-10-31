export type WindowLookup = (model: unknown, requestHeaders: Headers, upstream?: string) => Promise<number | null>

export interface WindowLookupOptions {
  known?: Map<string, number>
  onLearn?: (windows: Map<string, number>) => void
  timeoutMs?: number
  retryAfterMs?: number
}

const LOOKUP_TIMEOUT_MS = 1_500

const RETRY_AFTER_MS = 10 * 60_000

const LONG_SUFFIX = /\[1m\]$/i

const SUFFIX = /\[[^\]]*\]$/

function lookupHeaders(requestHeaders: Headers): Headers {
  const headers = new Headers()
  for (const name of ["authorization", "x-api-key", "anthropic-version", "anthropic-beta"]) {
    const value = requestHeaders.get(name)
    if (value) headers.set(name, value)
  }
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
  return headers
}

function familyWindow(model: string): number | null {
  if (LONG_SUFFIX.test(model)) return 1_000_000
  const id = model.replace(SUFFIX, "")
  if (/^claude-(?:opus|sonnet|haiku|fable)-5/.test(id)) return 1_000_000
  if (id.startsWith("claude-")) return 200_000
  return null
}

export function createWindowLookup({ known = new Map<string, number>(), onLearn, timeoutMs = LOOKUP_TIMEOUT_MS, retryAfterMs = RETRY_AFTER_MS }: WindowLookupOptions = {}): WindowLookup {
  const lookups = new Map<string, Promise<number | null>>()
  const failedAt = new Map<string, number>()
  const lookup = async (id: string, requestHeaders: Headers, upstream: string): Promise<number | null> => {
    const response = await fetch(`${upstream}/v1/models/${encodeURIComponent(id)}`, { headers: lookupHeaders(requestHeaders), signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    const info = (await response.json()) as { max_input_tokens?: number }
    if (typeof info.max_input_tokens !== "number" || info.max_input_tokens <= 0) return null
    known.set(id, info.max_input_tokens)
    onLearn?.(known)
    return info.max_input_tokens
  }
  return (model, requestHeaders, upstream = "https://api.anthropic.com") => {
    const given = String(model ?? "")
    const id = given.replace(SUFFIX, "")
    if (!id) return Promise.resolve(null)
    const window = known.get(id)
    if (window) return Promise.resolve(window)
    const fallback = familyWindow(given)
    const failed = failedAt.get(id)
    if (failed !== undefined && Date.now() - failed < retryAfterMs) return Promise.resolve(fallback)
    const inFlight = lookups.get(id)
    if (inFlight) return inFlight
    const pending = lookup(id, requestHeaders, upstream)
      .catch(() => null)
      .then((found) => {
        if (found !== null) return found
        failedAt.set(id, Date.now())
        return fallback
      })
      .finally(() => lookups.delete(id))
    lookups.set(id, pending)
    return pending
  }
}
