import { MAX_EVENT_BUFFER } from "./constants"
import type { Usage } from "./types"

function usageIn(line: string): Usage | null {
  if (!line.startsWith("data:") || !line.includes("message_start")) return null
  try {
    return JSON.parse(line.slice(5)).message?.usage ?? null
  } catch {
    return null
  }
}

function trailingUsage(buffer: string): Usage | null {
  if (!buffer.trim().startsWith("{")) return null
  try {
    const json = JSON.parse(buffer)
    if (json.usage) return json.usage
    return typeof json.input_tokens === "number" ? { input_tokens: json.input_tokens } : null
  } catch {
    return null
  }
}

function scanEvents(buffer: string): { usage: Usage | null; rest: string } {
  let rest = buffer
  while (true) {
    const newline = rest.indexOf("\n")
    if (newline === -1) return { usage: null, rest }
    const line = rest.slice(0, newline).trim()
    rest = rest.slice(newline + 1)
    const usage = usageIn(line)
    if (usage) return { usage, rest }
  }
}

async function readUsage(stream: ReadableStream): Promise<Usage | null> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  let usage: Usage | null = null
  while (true) {
    const { value, done } = await reader.read()
    if (done) return usage ?? trailingUsage(buffer)
    if (usage) continue
    const scanned = scanEvents(buffer + value)
    usage = scanned.usage
    buffer = scanned.rest.length > MAX_EVENT_BUFFER ? "" : scanned.rest
  }
}

export function watchUsage(response: Response, onUsage: (usage: Usage) => void): Response {
  if (!response.body) return response
  const [toClient, toUs] = response.body.tee()
  readUsage(toUs)
    .then((usage) => {
      if (usage) onUsage(usage)
    })
    .catch(() => undefined)
  return new Response(toClient, { status: response.status, statusText: response.statusText, headers: response.headers })
}

export function inputTokens(usage: Usage) {
  return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
}
