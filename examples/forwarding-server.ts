import { createServer, type IncomingMessage } from "node:http"
import { type Body, CORE_DEFAULTS, foldThread, memoryStore, rewrite } from "@chroxify/eunoe"

const UPSTREAM = process.env.UPSTREAM ?? "https://api.anthropic.com"
const WINDOW = Number(process.env.WINDOW ?? 200_000)
const PORT = Number(process.env.PORT ?? 8787)
const DROPPED_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding"])

const store = memoryStore()
const config = { ...CORE_DEFAULTS, mode: "compact" as const }

async function readText(request: IncomingMessage): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

function forwardedHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string" && !DROPPED_HEADERS.has(name)) headers.set(name, value)
  return headers
}

function rewritten(text: string, threadId: string, mayCompact: boolean): { text: string; action: string } {
  const out = rewrite({ body: JSON.parse(text) as Body, threadId, config, store, window: WINDOW, mayCompact })
  if (out.note.stuck) process.stderr.write(`thread ${threadId} cannot get under its target: ${JSON.stringify(out.note.stuck)}\n`)
  return { text: JSON.stringify(out.body), action: out.note.action }
}

createServer(async (request, response) => {
  const url = request.url ?? "/"
  const text = await readText(request)
  if (url === "/fold" && request.method === "POST" && text) {
    const { threadId, messages, at, pin } = JSON.parse(text)
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(foldThread({ store, threadId, messages }, { at, pin })))
    return
  }
  const threadId = request.headers["x-thread-id"]
  const isMessages = request.method === "POST" && url.startsWith("/v1/messages") && typeof threadId === "string" && text !== undefined
  const sent = isMessages ? rewritten(text, threadId, !url.includes("count_tokens")) : { text, action: "pass" }
  const upstream = await fetch(UPSTREAM + url, { method: request.method, headers: forwardedHeaders(request), body: sent.text })
  const headers = Object.fromEntries([...upstream.headers].filter(([name]) => name !== "content-encoding" && name !== "content-length"))
  response.writeHead(upstream.status, { ...headers, "x-eunoe-action": sent.action })
  if (upstream.body) for await (const chunk of upstream.body) response.write(chunk)
  response.end()
}).listen(PORT, () => process.stdout.write(`forwarding to ${UPSTREAM} on http://127.0.0.1:${PORT}\n`))
