import type { Body } from "../context/content"
import { sizeOf } from "./estimate"
import type { ThreadStore } from "./state"

export type Usage = Record<string, number>

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
  for (let newline = rest.indexOf("\n"); newline !== -1; newline = rest.indexOf("\n")) {
    const usage = usageIn(rest.slice(0, newline).trim())
    rest = rest.slice(newline + 1)
    if (usage) return { usage, rest }
  }
  return { usage: null, rest }
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
    buffer = scanned.rest.length > 4_000_000 ? "" : scanned.rest
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

const OVERFLOW_MARGIN = 1.1

const charsOf = (sent: Body | number) => (typeof sent === "number" ? sent : sizeOf(sent))

function overflowTokens(errorText: string): number | null {
  const tokens = Number(errorText.match(/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i)?.[1])
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null
}

export function recordUsage(store: ThreadStore, threadKey: string, sent: Body | number, usage: Usage): boolean {
  const input = inputTokens(usage)
  const chars = charsOf(sent)
  if (input <= 0 || chars <= 0) return false
  const state = store.read(threadKey)
  state.ratio = input / chars
  store.save(threadKey, state)
  return true
}

export function recordOverflow(store: ThreadStore, threadKey: string, sent: Body | number, errorText: string): number | null {
  const tokens = overflowTokens(errorText)
  const chars = charsOf(sent)
  if (!tokens || chars <= 0) return null
  const state = store.read(threadKey)
  state.ratio = Math.max(state.ratio ?? 0, tokens / chars) * OVERFLOW_MARGIN
  store.save(threadKey, state)
  return tokens
}
