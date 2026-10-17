import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { paths } from "../src/config/paths"
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
      if (url.pathname === "/v1/messages/count_tokens") {
        const stalls = Number(request.headers.get("x-test-stalls") ?? 0)
        const tries = received.filter((r) => r.path === url.pathname && r.headers.get("x-test-run") === request.headers.get("x-test-run")).length
        if (tries <= stalls) await Bun.sleep(2_000)
        return Response.json({ input_tokens: 42 })
      }
      if (request.headers.get("x-test-dense")) {
        const body = received.at(-1)!.body
        if (body.length > 60_000) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `prompt is too long: ${body.length} tokens > 60000 maximum` } }), { status: 400 })
      }
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
  return handle(
    new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test", ...headers },
      body: JSON.stringify({ model: "claude-test", system: "s", tools: [{ name: "Bash" }], messages }),
    }),
  )
}

const lastTo = (path: string) => [...received].reverse().find((r) => r.path === path)!
const logged = () =>
  existsSync(paths.requests)
    ? readFileSync(paths.requests, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : []

describe("proxy", () => {
  test("when the API says the prompt is too long, eunoe learns the real size, cuts and sends again; Claude Code never sees the error", async () => {
    const id = freshSession()
    const before = received.length
    const response = await post(session(20, 4_000), { "x-claude-code-session-id": id, "x-test-dense": "1" })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(sse)
    const tries = received.slice(before).filter((r) => r.path === "/v1/messages")
    expect(tries).toHaveLength(2)
    expect(tries[1].body.length).toBeLessThan(60_000)
    await Bun.sleep(50)
    const healed = logged().filter((r) => String(r.thread).startsWith(id))
    expect(healed.some((r) => r.overflow && r.status === 400)).toBe(true)
    expect(healed.some((r) => r.healed && r.status === 200)).toBe(true)
  })

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
    expect(sent).not.toContain('step a1"')
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
    writeFileSync(paths.config, JSON.stringify({ ...JSON.parse(previous), mode: "default", scope: "sessions", sessions: { [managed]: {} }, eval: { strategy: "trim" } }))
    try {
      const messages = session(3)
      await (await post(messages, { "x-claude-code-session-id": other })).text()
      expect(JSON.parse(lastTo("/v1/messages").body).messages).toEqual(messages)
      await (await post(messages, { "x-claude-code-session-id": managed })).text()
      expect(JSON.parse(lastTo("/v1/messages").body).messages.length).toBeLessThan(messages.length)
      const seen = JSON.parse(readFileSync(paths.sessions, "utf8"))
      expect(seen[other].mode).toBe("off")
      expect(seen[managed].mode).toBe("default")
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

describe("canonical context", () => {
  test("the first request captures system and tools; later ones are replaced, keeping their own billing line", async () => {
    const previous = readFileSync(paths.config, "utf8")
    writeFileSync(paths.config, JSON.stringify({ ...JSON.parse(previous), mode: "off", eval: { trustHeaders: true } }))
    const file = `${paths.threads}/canonical-${freshSession()}.json`
    const send = (system: string, tool: string) =>
      handle(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-eunoe-canonical": file, "x-claude-code-session-id": freshSession() },
          body: JSON.stringify({ model: "claude-test", system: [{ type: "text", text: `x-anthropic-billing-header: ${system}\nYou are an agent` }], tools: [{ name: "Bash", description: tool }], messages: session(1) }),
        }),
      )
    try {
      await (await send("v=1", "runs commands")).text()
      await (await send("v=2", "runs commands, differently")).text()
      const sent = JSON.parse(lastTo("/v1/messages").body)
      expect(sent.tools).toEqual([{ name: "Bash", description: "runs commands" }])
      expect(sent.system[0].text).toBe("x-anthropic-billing-header: v=2\nYou are an agent")
      await Bun.sleep(50)
      const entries = logged().slice(-2)
      expect(entries.map((e) => e.canonical)).toEqual(["captured", "applied"])
      expect(entries[1].context.given.tools).not.toBe(entries[0].context.given.tools)
      expect(entries[1].context.tools).toBe(entries[0].context.tools)
    } finally {
      writeFileSync(paths.config, previous)
    }
  })
})

describe("token counts", () => {
  const count = (run: string, stalls: number) =>
    handle(
      new Request("http://127.0.0.1/v1/messages/count_tokens", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test", "x-claude-code-session-id": freshSession(), "x-test-run": run, "x-test-stalls": String(stalls) },
        body: JSON.stringify({ model: "claude-test", messages: session(1) }),
      }),
      { countTokensTimeoutMs: 100 },
    )

  test("a count that hangs upstream is sent again instead of holding Claude Code's tool call", async () => {
    const run = crypto.randomUUID()
    const started = Date.now()
    const response = await count(run, 2)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ input_tokens: 42 })
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(received.filter((r) => r.headers.get("x-test-run") === run)).toHaveLength(3)
    await Bun.sleep(20)
    const entry = logged().findLast((r) => r.path === "/v1/messages/count_tokens")
    expect(entry).toMatchObject({ status: 200, stalled: 2 })
    expect(entry.ms).toBeGreaterThanOrEqual(200)
  })

  test("a count that keeps hanging becomes a 502 Claude Code can retry", async () => {
    const run = crypto.randomUUID()
    const response = await count(run, 3)
    expect(response.status).toBe(502)
    expect(received.filter((r) => r.headers.get("x-test-run") === run)).toHaveLength(3)
  })
})

describe("upstream outage", () => {
  test("an unreachable API becomes a 502 error Claude Code can retry, not a crash", async () => {
    const saved = readFileSync(paths.config, "utf8")
    await Bun.sleep(5)
    writeFileSync(paths.config, JSON.stringify({ upstream: "http://127.0.0.1:1", mode: "compact" }))
    try {
      const response = await handle(new Request("http://127.0.0.1/v1/other"))
      expect(response.status).toBe(502)
      expect((await response.json()).error.type).toBe("api_error")
    } finally {
      await Bun.sleep(5)
      writeFileSync(paths.config, saved)
    }
  })
})
