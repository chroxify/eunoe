import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { paths } from "../src/config/constants"
import { handle } from "../src/proxy/server"
import { freshSession, session } from "./fixtures"

const received: Array<{ path: string; body: string; headers: Headers }> = []
let upstream: ReturnType<typeof Bun.serve>

const sse = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: "hello" } })}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
].join("")

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      received.push({ path: url.pathname, body: await request.text(), headers: request.headers })
      if (url.pathname.startsWith("/v1/models/")) return Response.json({ id: url.pathname.split("/").pop(), max_input_tokens: 60_000 })
      if (url.pathname === "/v1/fail") return new Response('{"error":"nope"}', { status: 400 })
      if (request.headers.get("x-test-error")) return new Response('{"type":"error","error":{"type":"invalid_request_error"}}', { status: 400 })
      if (url.pathname === "/v1/messages") return new Response(sse, { headers: { "content-type": "text/event-stream" } })
      return new Response("ok")
    },
  })
  mkdirSync(paths.threads, { recursive: true })
  writeFileSync(paths.config, JSON.stringify({ upstream: `http://127.0.0.1:${upstream.port}`, mode: "compact" }))
})

afterAll(() => upstream.stop(true))

function post(messages: unknown, headers: Record<string, string> = {}) {
  return handle(new Request("http://127.0.0.1/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test", ...headers },
    body: JSON.stringify({ model: "claude-test", system: "s", tools: [{ name: "Bash" }], messages }),
  }))
}

const lastTo = (path: string) => [...received].reverse().find((r) => r.path === path)!
const logged = () => (existsSync(paths.requests) ? readFileSync(paths.requests, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [])

describe("proxy", () => {
  test("non-message requests are forwarded untouched", async () => {
    const response = await handle(new Request("http://127.0.0.1/v1/other?x=1"))
    expect(await response.text()).toBe("ok")
    expect(lastTo("/v1/other")).toBeDefined()
  })

  test("a small conversation goes upstream byte for byte, the stream comes back intact, and usage is logged", async () => {
    const id = freshSession()
    const messages = session(2)
    const response = await post(messages, { "x-claude-code-session-id": id })
    expect(await response.text()).toBe(sse)
    expect(JSON.parse(lastTo("/v1/messages").body).messages).toEqual(messages)
    expect(lastTo("/v1/messages").headers.get("authorization")).toBe("Bearer test")
    await Bun.sleep(50)
    const entry = logged().find((r) => String(r.thread).startsWith(id))
    expect(entry).toMatchObject({ action: "full", input: 1203, cacheRead: 1000, cacheWrite: 200 })
  })

  test("the window comes from the Models API, and a conversation past it is compacted on the wire", async () => {
    const id = freshSession()
    const response = await post(session(20, 12_000), { "x-claude-code-session-id": id })
    expect(response.status).toBe(200)
    await response.text()
    expect(received.some((r) => r.path === "/v1/models/claude-test")).toBe(true)
    const sent = lastTo("/v1/messages").body
    expect(sent).toContain("<context-compacted>")
    expect(sent).toContain("answer 20")
    expect(sent).not.toContain("step a1\"")
    await Bun.sleep(50)
    expect(logged().find((r) => String(r.thread).startsWith(id))).toMatchObject({ compacted: true, window: 60_000 })
  })

  test("upstream errors come back with their status and body", async () => {
    const response = await post(session(1), { "x-claude-code-session-id": freshSession(), "x-test-error": "1" })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("invalid_request_error")
  })

  test("a body eunoe can't parse is forwarded as it was", async () => {
    const response = await handle(new Request("http://127.0.0.1/v1/messages", { method: "POST", body: "{not json" }))
    expect(response.status).toBe(200)
    expect(lastTo("/v1/messages").body).toBe("{not json")
  })
})

describe("per-session scope", () => {
  test("only the sessions you enable get rewritten; the rest pass through and are remembered", async () => {
    const managed = freshSession()
    const other = freshSession()
    const previous = readFileSync(paths.config, "utf8")
    writeFileSync(paths.config, JSON.stringify({ ...JSON.parse(previous), mode: "trim", scope: "sessions", sessions: { [managed]: {} } }))
    try {
      const messages = session(3)
      await (await post(messages, { "x-claude-code-session-id": other })).text()
      expect(JSON.parse(lastTo("/v1/messages").body).messages).toEqual(messages)
      await (await post(messages, { "x-claude-code-session-id": managed })).text()
      expect(JSON.parse(lastTo("/v1/messages").body).messages.length).toBeLessThan(messages.length)
      const seen = JSON.parse(readFileSync(paths.sessions, "utf8"))
      expect(seen[other].mode).toBe("off")
      expect(seen[managed].mode).toBe("trim")
    } finally {
      writeFileSync(paths.config, previous)
    }
  })
})

describe("per-session settings", () => {
  test("a session's own compactAt decides when its cut happens; others keep the default", async () => {
    const early = freshSession()
    const other = freshSession()
    const previous = readFileSync(paths.config, "utf8")
    writeFileSync(paths.config, JSON.stringify({ ...JSON.parse(previous), mode: "compact", compactAt: 0.9, sessions: { [early]: { compactAt: 0.05 } } }))
    try {
      const messages = session(6, 2_000)
      await (await post(messages, { "x-claude-code-session-id": other })).text()
      expect(JSON.parse(lastTo("/v1/messages").body).messages).toEqual(messages)
      await (await post(messages, { "x-claude-code-session-id": early })).text()
      expect(JSON.parse(lastTo("/v1/messages").body).messages.length).toBeLessThan(messages.length)
    } finally {
      writeFileSync(paths.config, previous)
    }
  })
})

describe("evaluation logging", () => {
  test("each request records what the agent was given: system prompt, tools and loaded skills", async () => {
    const id = freshSession()
    const previous = readFileSync(paths.config, "utf8")
    writeFileSync(paths.config, JSON.stringify({ ...JSON.parse(previous), mode: "off", eval: {} }))
    try {
      const messages = [...session(1), { role: "user", content: [{ type: "text", text: "Base directory for this skill: /plugins/x/skills/deploy\n\n# Deploy" }] }]
      await (await post(messages, { "x-claude-code-session-id": id })).text()
      await Bun.sleep(50)
      const entry = logged().at(-1)
      expect(entry.context.skills).toEqual(["deploy"])
      expect(entry.context.system).toHaveLength(12)
      expect(entry.context.tools).toHaveLength(12)
    } finally {
      writeFileSync(paths.config, previous)
    }
  })
})

