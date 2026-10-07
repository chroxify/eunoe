import { MAX_EVENT_BUFFER } from "./constants"
import type { Usage } from "./types"

export function watchUsage(response: Response, onUsage: (usage: Usage) => void): Response {
  if (!response.body) return response
  const [toClient, toUs] = response.body.tee()
  void (async () => {
    const reader = toUs.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    let found = false
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (found) continue
      buffer += value
      let newline: number
      while (!found && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith("data:") || !line.includes("message_start")) continue
        try {
          const event = JSON.parse(line.slice(5))
          if (event.message?.usage) {
            found = true
            onUsage(event.message.usage)
          }
        } catch {}
      }
      if (!found && buffer.length > MAX_EVENT_BUFFER) buffer = ""
    }
    if (!found && buffer.trim().startsWith("{")) {
      try {
        const json = JSON.parse(buffer)
        if (json.usage) onUsage(json.usage)
        else if (typeof json.input_tokens === "number") onUsage({ input_tokens: json.input_tokens })
      } catch {}
    }
  })().catch(() => undefined)
  return new Response(toClient, { status: response.status, statusText: response.statusText, headers: response.headers })
}

export function inputTokens(usage: Usage) {
  return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
}
