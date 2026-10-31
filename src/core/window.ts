export type WindowLookup = (model: unknown, requestHeaders: Headers, upstream?: string) => Promise<number | null>

const LOOKUP_TIMEOUT_MS = 5_000

function lookupHeaders(requestHeaders: Headers): Headers {
  const headers = new Headers()
  for (const name of ["authorization", "x-api-key", "anthropic-version", "anthropic-beta"]) {
    const value = requestHeaders.get(name)
    if (value) headers.set(name, value)
  }
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
  return headers
}

export function createWindowLookup({ known = new Map<string, number>(), onLearn }: { known?: Map<string, number>; onLearn?: (windows: Map<string, number>) => void } = {}): WindowLookup {
  const lookups = new Map<string, Promise<number | null>>()
  const lookup = async (id: string, requestHeaders: Headers, upstream: string): Promise<number | null> => {
    const response = await fetch(`${upstream}/v1/models/${encodeURIComponent(id)}`, { headers: lookupHeaders(requestHeaders), signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })
    if (!response.ok) return null
    const info = (await response.json()) as { max_input_tokens?: number }
    if (typeof info.max_input_tokens !== "number" || info.max_input_tokens <= 0) return null
    known.set(id, info.max_input_tokens)
    onLearn?.(known)
    return info.max_input_tokens
  }
  return (model, requestHeaders, upstream = "https://api.anthropic.com") => {
    const id = String(model ?? "").replace(/\[[^\]]*\]$/, "")
    if (!id) return Promise.resolve(null)
    const window = known.get(id)
    if (window) return Promise.resolve(window)
    const inFlight = lookups.get(id)
    if (inFlight) return inFlight
    const pending = lookup(id, requestHeaders, upstream)
      .catch(() => null)
      .finally(() => lookups.delete(id))
    lookups.set(id, pending)
    return pending
  }
}
