import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { type Body, CORE_DEFAULTS, rewrite, type ThreadState, type ThreadStore } from "@chroxify/eunoe"

const PORT = Number(process.env.PORT ?? 38700)
const UPSTREAM = process.env.UPSTREAM ?? "https://api.anthropic.com"
const WINDOW = 1_000_000
const THREADS = path.join(homedir(), ".my-proxy", "threads")

const fileOf = (key: string) => path.join(THREADS, `${key.replace(/[^\w-]/g, "_")}.json`)

const store: ThreadStore = {
  read: (key) => {
    try {
      return JSON.parse(readFileSync(fileOf(key), "utf8")) as ThreadState
    } catch {
      return {}
    }
  },
  save: (key, state) => {
    mkdirSync(THREADS, { recursive: true })
    writeFileSync(fileOf(key), JSON.stringify(state))
  },
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  for (const name of ["host", "content-length", "accept-encoding"]) headers.delete(name)
  const threadId = request.headers.get("x-claude-code-session-id")
  let body: string | undefined = await request.text()
  if (request.method === "GET" || request.method === "HEAD") body = undefined
  if (body && threadId && url.pathname.startsWith("/v1/messages")) {
    const out = rewrite({ body: JSON.parse(body) as Body, threadId, config: CORE_DEFAULTS, store, window: WINDOW, mayCompact: !url.pathname.includes("count_tokens") })
    body = JSON.stringify(out.body)
  }
  const upstream = await fetch(UPSTREAM + url.pathname + url.search, { method: request.method, headers, body })
  const passed = new Headers(upstream.headers)
  passed.delete("content-encoding")
  passed.delete("content-length")
  return new Response(upstream.body, { status: upstream.status, headers: passed })
}

Bun.serve({ port: PORT, hostname: "127.0.0.1", idleTimeout: 255, fetch: handle })
process.stdout.write(`ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} claude\n`)
