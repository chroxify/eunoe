import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { paths } from "../src/config/paths"
import { sha256 } from "../src/context/content"
import { capTurns, compactMessages } from "../src/context/fold/strategies"
import { turnFingerprint } from "../src/context/fold/turns"
import {
  CORE_DEFAULTS,
  createForwarder,
  createWindowLookup,
  foldThread,
  listSubagentRecall,
  type Message,
  memoryStore,
  pinTurns,
  type RewriteInput,
  recordOverflow,
  recordUsage,
  renderTranscriptFiles,
  rewrite,
  rewriteAsync,
  threadKeyOf,
  transcriptGuide,
} from "../src/core"
import { call, reply, result, session, turn, user } from "./fixtures"

const body = (messages: Message[]) => ({ system: "s", tools: [{ name: "Bash" }], messages })
const tight = { ...CORE_DEFAULTS, compactAt: 0.1 }
const input = (messages: Message[], patch: Partial<RewriteInput> = {}): RewriteInput => ({
  body: body(messages),
  threadId: "host-thread",
  config: CORE_DEFAULTS,
  store: memoryStore(),
  window: 100_000,
  mayCompact: true,
  ...patch,
})
const sent = (messages: Message[]) => JSON.stringify(messages)
const threadFiles = () => (existsSync(paths.threads) ? readdirSync(paths.threads) : [])

describe("the core", () => {
  test("folds a long thread into the store it is given and leaves the disk alone", () => {
    const before = threadFiles()
    const store = memoryStore()
    const messages = session(20, 3_000)
    const out = rewrite(input(messages, { store, config: tight }))
    expect(out.note.action).toBe("compact")
    expect(out.threadKey).toBe(threadKeyOf("host-thread", messages))
    expect(store.read(out.threadKey as string).cut).toBeString()
    expect(threadFiles()).toEqual(before)
  })

  test("the same history and state give the same bytes, and growth only appends", () => {
    const store = memoryStore()
    const messages = session(20, 3_000)
    const first = rewrite(input(messages, { store, config: tight }))
    const again = rewrite(input(messages, { store, config: tight }))
    expect(sent(again.body.messages)).toBe(sent(first.body.messages))
    const grown = rewrite(input([...messages, call("y"), result("y")], { store, config: tight }))
    expect(sent(grown.body.messages).startsWith(sent(first.body.messages).slice(0, -1))).toBe(true)
  })

  test("a separate store is a separate thread", () => {
    const messages = session(20, 3_000)
    const shared = memoryStore()
    rewrite(input(messages, { store: shared, config: tight }))
    expect(shared.read(threadKeyOf("host-thread", messages) as string).cut).toBeString()
    expect(memoryStore().read(threadKeyOf("host-thread", messages) as string)).toEqual({})
  })

  test("off, a missing thread id and an empty body pass through untouched", () => {
    const messages = session(3)
    for (const patch of [{ config: { ...CORE_DEFAULTS, mode: "off" as const } }, { threadId: null }]) {
      const given = input(messages, patch)
      expect(rewrite(given)).toEqual({ body: given.body, threadKey: null, note: { action: "pass" } })
    }
    expect(rewrite(input([])).note.action).toBe("pass")
  })

  test("recalls from the history a host supplies when the body itself has nothing dropped", () => {
    const history: Message[] = [user("deploy it"), call("d", { command: "bun run deploy" }), { role: "user", content: [{ type: "tool_result", tool_use_id: "d", content: "Deployment ID: dpl_hostsupplied42\ndone" }] }, reply("deployed")]
    const messages = [user("first"), reply("ok"), user("what deployment id did the deploy print?")]
    const out = rewrite(input(messages, { sources: { readHistory: () => history } }))
    expect(out.note.recalled).toBeGreaterThan(0)
    expect(sent(out.body.messages)).toContain("dpl_hostsupplied42")
  })

  test("attaches a handoff from the session a host resolves", () => {
    const earlier = [user("always use the yalsho/ branch prefix"), reply("Noted.")]
    const sources = { findHandoff: (id: string) => (id === "prior-aaaaaaaa" ? { label: "Earlier work", source: "prior" } : null), readHandoff: () => earlier }
    const out = rewrite(input([user("{ee:continue:prior-aaaaaaaa} carry on")], { sources }))
    expect(sent(out.body.messages)).toContain('<handoff from=\\"Earlier work\\">')
    expect(sent(out.body.messages)).toContain("yalsho/")
  })

  test("rewriteAsync asks the reranker the host passes in", async () => {
    const asked: string[] = []
    const history: Message[] = [user("deploy it"), call("d"), { role: "user", content: [{ type: "tool_result", tool_use_id: "d", content: "Deployment ID: dpl_reranked77\nDeployment ID: dpl_other88" }] }, reply("deployed")]
    const out = await rewriteAsync(input([user("first"), reply("ok"), user("which deployment id did it print?")], { sources: { readHistory: () => history } }), async (query, _chunks, candidates) => {
      asked.push(query)
      return candidates
    })
    expect(asked).toHaveLength(1)
    expect(out.note.recalled).toBeGreaterThan(0)
  })
})

test("the portable sha256 matches Bun's, so thread keys and fingerprints don't change", () => {
  const native = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
  for (const text of ["", "abc", "é漢字🙂", "x".repeat(55), "x".repeat(56), "x".repeat(64), "y".repeat(100_003)]) expect(sha256(text)).toBe(native(text))
})

describe("host folds", () => {
  const plan: Message[] = [
    user("plan the remote tunnel"),
    { role: "assistant", content: [{ type: "tool_use", id: "plan", name: "propose_plan", input: { goal: "PLAN-ALPHA: seal the channel, then pair devices" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "plan", content: "Handed over." }] },
    reply("The plan is in."),
  ]
  const earlier = [user("first"), reply("ok"), ...[1, 2, 3, 4, 5].flatMap((n) => turn(n, { output: 3_000 }))]
  const PLAN_TURN = 6
  const history = [...earlier, ...plan, user("build phase 1")]
  const roomy = (mode: "off" | "compact" | "default") => ({ ...CORE_DEFAULTS, mode })
  const send = (store: ReturnType<typeof memoryStore>, messages: Message[], mode: "off" | "compact" | "default" = "compact") => rewrite(input(messages, { store, config: roomy(mode), window: 1_000_000 }))
  const target = (store: ReturnType<typeof memoryStore>, messages = history) => ({ store, threadId: "host-thread", messages })

  for (const mode of ["off", "compact", "default"] as const) {
    test(`fold at a boundary in ${mode} mode: earlier turns fold, the pinned plan stays whole`, () => {
      const store = memoryStore()
      expect(foldThread(target(store), { pin: [PLAN_TURN] })).toEqual({ threadKey: threadKeyOf("host-thread", history) as string, cutTurn: PLAN_TURN + 1, pinned: [PLAN_TURN] })
      const out = send(store, history, mode)
      const text = sent(out.body.messages)
      for (let n = 1; n <= 5; n += 1) expect(text).toContain(`answer ${n}`)
      expect(text).not.toContain("step a3")
      expect(text).toContain("PLAN-ALPHA")
      expect(text).toContain("Handed over.")
      expect(text).toContain("kept whole, with their tool calls")
      expect(text).toContain("build phase 1")
      expect(out.note).toMatchObject({ action: "compact", cutTurn: PLAN_TURN + 1, pinned: 1, folded: 6, omitted: 0, host: true })
    })
  }

  test("the first turn folds like the rest instead of losing its reply", () => {
    const store = memoryStore()
    const messages = [user("plan it"), reply("PLAN-ZERO: two steps"), user("step one"), call("s1"), result("s1"), reply("step one done"), user("step two")]
    foldThread({ store, threadId: "host-thread", messages })
    const out = send(store, messages)
    expect(sent(out.body.messages)).toContain("PLAN-ZERO")
    expect(sent(out.body.messages)).toContain("step one done")
    expect(sent(out.body.messages.slice(0, -1))).not.toContain("step s1")
    expect(out.note).toMatchObject({ cutTurn: 2, folded: 2, omitted: 0 })
  })

  test("without a host fold, off mode still passes through", () => {
    expect(send(memoryStore(), history, "off").note.action).toBe("pass")
  })

  test("the folded request is byte-stable as the step goes on, wherever the cache breakpoints move", () => {
    const store = memoryStore()
    foldThread(target(store), { pin: [PLAN_TURN] })
    const first = sent(send(store, history).body.messages)
    expect(sent(send(store, history).body.messages)).toBe(first)
    const marked = history.map((m, i) => (i === earlier.length + 1 ? { ...m, content: (m.content as any[]).map((b) => ({ ...b, cache_control: { type: "ephemeral" } })) } : m))
    const grown = sent(send(store, [...marked, call("b1"), result("b1")]).body.messages)
    expect(grown.startsWith(first.slice(0, -1))).toBe(true)
  })

  test("unpinning folds the plan like any other turn", () => {
    const store = memoryStore()
    foldThread(target(store), { pin: [PLAN_TURN] })
    expect(pinTurns(target(store), [PLAN_TURN], false).pinned).toEqual([])
    const text = sent(send(store, history).body.messages)
    expect(text).not.toContain("PLAN-ALPHA")
    expect(text).toContain("The plan is in.")
  })

  test("pinning on its own keeps a turn whole once a cut reaches past it", () => {
    const store = memoryStore()
    expect(pinTurns(target(store), [2]).pinned).toEqual([2])
    const out = rewrite(input(session(20, 3_000), { store, config: tight }))
    expect(out.note.pinned).toBe(1)
    expect(sent(out.body.messages)).toContain("step a2")
    expect(sent(out.body.messages)).not.toContain("step a3")
  })

  test("a boundary or pin outside the thread is refused", () => {
    const store = memoryStore()
    expect(() => foldThread(target(store), { at: 0 })).toThrow(RangeError)
    expect(() => foldThread(target(store), { at: 99 })).toThrow(RangeError)
    expect(() => pinTurns(target(store), [99])).toThrow(RangeError)
    expect(() => foldThread(target(store, []))).toThrow(RangeError)
  })

  test("a later automatic cut takes over from the host's, and pins survive it", () => {
    const store = memoryStore()
    foldThread(target(store), { pin: [PLAN_TURN] })
    const next = [...history, call("b1"), result("b1", 3_000), reply("phase 1 built"), user("build phase 2"), call("b2"), result("b2", 80_000)]
    const out = rewrite(input(next, { store, config: { ...CORE_DEFAULTS, mode: "compact" }, window: 20_000 }))
    expect(out.note.cutTurn).toBe(PLAN_TURN + 2)
    expect(out.note.host).toBeUndefined()
    expect(sent(out.body.messages)).toContain("PLAN-ALPHA")
  })

  test("a pinned turn is kept whole even where folds drop or cap turns", () => {
    const messages = [...turn(0), ...turn(1, { output: 5_000 }), ...turn(2, { output: 5_000 }), ...turn(3, { done: false })]
    const pinned = new Set([turnFingerprint(turn(1))])
    const dropped = sent(compactMessages(messages, 3, { keepTurns: 0, guide: null, pinned }))
    expect(dropped).toContain("step a1")
    expect(dropped).not.toContain("step a2")
    expect(dropped).toContain("One earlier turn was kept whole")
    const capped = sent(capTurns(messages, { keepTurns: 0, guide: null, capChars: 1_000, pinned }))
    expect(capped).toContain("step a1")
    expect(capped).not.toContain("step a2")
  })
})

describe("the forwarder", () => {
  const usage = { input_tokens: 3, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 1_000 }
  const sse = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`
  const fakeApi = (answers: Array<(body: any) => Response>) => {
    const received: any[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.startsWith("/v1/models/")) return Response.json({ max_input_tokens: 100_000 })
        const sentBody = await request.json()
        received.push(sentBody)
        return (answers[received.length - 1] ?? answers.at(-1) ?? (() => new Response(sse)))(sentBody)
      },
    })
    return { received, upstream: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
  }
  const post = (forward: (request: Request) => Promise<Response>, messages: Message[]) =>
    forward(new Request("http://eunoe.local/v1/messages", { method: "POST", headers: { "x-thread-id": "fw" }, body: JSON.stringify({ ...body(messages), model: "claude-test" }) }))

  test("rewrites, forwards, streams the answer back and learns the token ratio from its usage", async () => {
    const api = fakeApi([() => new Response(sse, { headers: { "content-type": "text/event-stream" } })])
    const store = memoryStore()
    const records: any[] = []
    const forward = createForwarder({ store, upstream: api.upstream, config: tight, record: (entry) => records.push(entry) })
    const messages = session(20, 3_000)
    const response = await post(forward, messages)
    expect(await response.text()).toContain("message_start")
    await Bun.sleep(20)
    api.stop()
    expect(api.received[0].messages.length).toBeLessThan(messages.length)
    expect(records[0]).toMatchObject({ action: "compact", status: 200, input: 10_003, window: 100_000 })
    expect(store.read(threadKeyOf("fw", messages) as string).ratio).toBeCloseTo(10_003 / records[0].charsOut, 6)
  })

  test("heals a prompt-too-long by learning the real size and retrying once", async () => {
    const tooLong = () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } }, { status: 400 })
    const api = fakeApi([tooLong, () => new Response(sse)])
    const store = memoryStore()
    const records: any[] = []
    const forward = createForwarder({ store, upstream: api.upstream, window: 200_000, record: (entry) => records.push(entry) })
    const response = await post(forward, session(30, 20_000))
    await response.text()
    await Bun.sleep(20)
    api.stop()
    expect(response.status).toBe(200)
    expect(api.received).toHaveLength(2)
    expect(api.received[1].messages.length).toBeLessThan(api.received[0].messages.length)
    expect(records.map((r) => r.overflow ?? r.healed)).toEqual([250_000, 250_000])
  })

  test("heals against the limit the error gives when it is below the window, and keeps it for later requests", async () => {
    const limit = 50_000
    const sizes: number[] = []
    const server = Bun.serve({
      port: 0,
      maxRequestBodySize: 1 << 30,
      async fetch(request) {
        const text = await request.text()
        sizes.push(text.length)
        const tokens = Math.ceil(text.length / 3.6)
        if (tokens > limit) return Response.json({ type: "error", error: { type: "invalid_request_error", message: `prompt is too long: ${tokens} tokens > ${limit} maximum` } }, { status: 400 })
        return Response.json({ id: "m", usage: { input_tokens: tokens } })
      },
    })
    const store = memoryStore()
    const records: any[] = []
    const forward = createForwarder({ store, upstream: `http://127.0.0.1:${server.port}`, window: 200_000, record: (entry) => records.push(entry) })
    const messages = [0, 1, 2, 3].flatMap((i) => [user(`Prompt ${i}`), call(`t${i}`), result(`t${i}`, 50_000), reply("ok")])
    const response = await post(forward, [...messages, user("go")])
    await response.text()
    const later = await post(forward, [...messages, user("go"), reply("done"), user("and again")])
    await later.text()
    server.stop(true)
    expect(response.status).toBe(200)
    expect(sizes).toHaveLength(3)
    expect(sizes[1]).toBeLessThan(sizes[0] / 2)
    expect(store.read(threadKeyOf("fw", messages) as string).limits).toEqual({ "claude-test": limit })
    expect(later.status).toBe(200)
    expect(records.at(-1)).toMatchObject({ status: 200, window: limit })
  })

  test("a limit learned on one model does not cap the thread once it switches model", () => {
    const store = memoryStore()
    const messages = session(4)
    const key = threadKeyOf("t", messages) as string
    recordOverflow(store, key, 100_000, "prompt is too long: 250000 tokens > 200000 maximum", "claude-haiku-4-5")
    const on = (model: string) => rewrite(input(messages, { store, threadId: "t", window: 1_000_000, body: { ...body(messages), model } }))
    expect(on("claude-haiku-4-5").note.window).toBe(200_000)
    expect(on("claude-opus-5-5").note.window).toBe(1_000_000)
  })

  test("answers 502 when the API is unreachable", async () => {
    const forward = createForwarder({ store: memoryStore(), upstream: "http://127.0.0.1:9", window: null })
    expect((await post(forward, session(2))).status).toBe(502)
  })
})

describe("calibration", () => {
  test("recordUsage keeps the ratio of real input tokens to characters sent", () => {
    const store = memoryStore()
    expect(recordUsage(store, "k", 1_000, { input_tokens: 10, cache_read_input_tokens: 290 })).toBe(true)
    expect(store.read("k").ratio).toBe(0.3)
    expect(recordUsage(store, "k", 1_000, {})).toBe(false)
  })

  test("recordOverflow raises the ratio past what the API counted", () => {
    const store = memoryStore()
    expect(recordOverflow(store, "k", 100_000, "prompt is too long: 40000 tokens > 30000 maximum")).toBe(40_000)
    expect(store.read("k").limits).toEqual({ "": 30_000 })
    expect(store.read("k").ratio).toBeCloseTo(0.44, 6)
    expect(recordOverflow(store, "k", 100_000, "overloaded")).toBeNull()
    recordOverflow(store, "k", { model: "claude-opus-5-5", messages: [] }, "prompt is too long: 40000 tokens > 35000 maximum")
    expect(store.read("k").limits).toEqual({ "": 30_000, "claude-opus-5-5": 35_000 })
  })

  test("createWindowLookup asks the Models API once per model and remembers it", async () => {
    let asked = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        asked += 1
        return Response.json({ max_input_tokens: 1_000_000 })
      },
    })
    const learned: number[] = []
    const lookup = createWindowLookup({ onLearn: (windows) => learned.push(windows.size) })
    const upstream = `http://127.0.0.1:${server.port}`
    expect(await lookup("claude-opus-5-5[1m]", new Headers(), upstream)).toBe(1_000_000)
    expect(await lookup("claude-opus-5-5", new Headers(), upstream)).toBe(1_000_000)
    server.stop(true)
    expect(asked).toBe(1)
    expect(learned).toEqual([1])
  })

  const modelsApi = (answer: () => Response | Promise<Response>) => {
    let asked = 0
    const server = Bun.serve({
      port: 0,
      idleTimeout: 30,
      fetch: () => {
        asked += 1
        return answer()
      },
    })
    return { upstream: `http://127.0.0.1:${server.port}`, asked: () => asked, stop: () => server.stop(true) }
  }

  test("createWindowLookup falls back to the model family's window when the Models API refuses, and asks only once", async () => {
    const api = modelsApi(() => Response.json({ type: "error", error: { type: "authentication_error" } }, { status: 401 }))
    const lookup = createWindowLookup()
    expect(await lookup("claude-opus-5-5", new Headers(), api.upstream)).toBe(1_000_000)
    expect(await lookup("claude-opus-5-5", new Headers(), api.upstream)).toBe(1_000_000)
    expect(await lookup("claude-haiku-4-5-20251001", new Headers(), api.upstream)).toBe(200_000)
    expect(await lookup("claude-opus-4-8", new Headers(), api.upstream)).toBe(1_000_000)
    expect(await lookup("claude-sonnet-4-6[1m]", new Headers(), api.upstream)).toBe(1_000_000)
    expect(await lookup("gpt-5", new Headers(), api.upstream)).toBeNull()
    api.stop()
    expect(api.asked()).toBe(5)
  })

  test("createWindowLookup gives up on a hanging Models API after its timeout and does not wait again", async () => {
    const api = modelsApi(async () => {
      await Bun.sleep(2_000)
      return Response.json({ max_input_tokens: 1 })
    })
    const lookup = createWindowLookup({ timeoutMs: 50 })
    const began = Date.now()
    expect(await lookup("claude-sonnet-4-6", new Headers(), api.upstream)).toBe(200_000)
    expect(await lookup("claude-sonnet-4-6", new Headers(), api.upstream)).toBe(200_000)
    expect(Date.now() - began).toBeLessThan(1_000)
    api.stop()
    expect(api.asked()).toBe(1)
  })

  test("createWindowLookup gives each caller of a shared lookup its own fallback", async () => {
    const api = modelsApi(async () => {
      await Bun.sleep(20)
      return new Response("no", { status: 401 })
    })
    const lookup = createWindowLookup()
    const [plain, long] = await Promise.all([lookup("claude-sonnet-4-6", new Headers(), api.upstream), lookup("claude-sonnet-4-6[1m]", new Headers(), api.upstream)])
    api.stop()
    expect([plain, long]).toEqual([200_000, 1_000_000])
    expect(api.asked()).toBe(1)
  })

  test("createWindowLookup asks again once the failure is old enough", async () => {
    let refuse = true
    const api = modelsApi(() => (refuse ? new Response("no", { status: 503 }) : Response.json({ max_input_tokens: 400_000 })))
    const lookup = createWindowLookup({ retryAfterMs: 0 })
    expect(await lookup("claude-opus-5-5", new Headers(), api.upstream)).toBe(1_000_000)
    refuse = false
    expect(await lookup("claude-opus-5-5", new Headers(), api.upstream)).toBe(400_000)
    api.stop()
  })
})

describe("transcripts from the host's own messages", () => {
  const messages: Message[] = [
    user("deploy staging"),
    call("d", { command: "bun run deploy" }),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "d", content: "Deployment ID: dpl_transcript1" }] },
    { role: "user", content: "[Image: original 2560x1440, displayed at 2000x1125. Multiply coordinates by 1.28 to map to original image.]" },
    reply("Deployed."),
    user("now tag it"),
    reply("Tagged."),
  ]

  test("renders one file per turn and an index, ready to store anywhere", () => {
    const files = renderTranscriptFiles(messages)
    expect(Object.keys(files).sort()).toEqual(["index.md", "turn-0001.md", "turn-0002.md"])
    expect(files["turn-0001.md"]).toContain("Deployment ID: dpl_transcript1")
    expect(files["turn-0001.md"]).toContain("bun run deploy")
    expect(files["index.md"]).toContain("deploy staging")
    expect(Object.keys(renderTranscriptFiles(messages, { format: "xml" }))).toContain("turn-0001.xml")
  })

  test("the guide points the agent at where the host stored them", () => {
    const guide = transcriptGuide("/data/threads/t1/transcript")
    expect(guide).toContain("/data/threads/t1/transcript")
    const out = rewrite(input(session(20, 3_000), { config: tight, sources: { guide, transcriptDir: "/data/threads/t1/transcript" } }))
    expect(sent(out.body.messages)).toContain("/data/threads/t1/transcript")
  })
})

describe("subagents the host ran", () => {
  const launch: Message = { role: "assistant", content: [{ type: "tool_use", id: "agent1", name: "Agent", input: { description: "find the flaky test", prompt: "find it" } }] }
  const parent: Message[] = [user("why is CI red?"), launch, { role: "user", content: [{ type: "tool_result", tool_use_id: "agent1", content: "It is the retry test." }] }, reply("The retry test is flaky."), user("which seed made it fail?")]
  const subagent = {
    description: "find the flaky test",
    toolUseId: "agent1",
    messages: [
      user("find it"),
      call("s1", { command: "bun test --seed 4242" }),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "FAIL retry.test.ts with seed 4242" }] },
      reply("It is the retry test."),
    ] as Message[],
  }

  test("what only the subagent saw comes back through recall, labelled with the subagent", () => {
    const chunks = listSubagentRecall(parent, [subagent])
    expect(chunks.every((chunk) => chunk.from === 'subagent "find the flaky test"' && chunk.turn === 1)).toBe(true)
    const out = rewrite(input(parent, { sources: { listSubagentChunks: () => chunks } }))
    expect(out.note.recalled).toBeGreaterThan(0)
    expect(sent(out.body.messages)).toContain("seed 4242")
  })

  test("the transcript gets one file per subagent run, linked from the call that launched it", () => {
    const files = renderTranscriptFiles(parent, { subagents: [subagent] })
    expect(files["turn-0001-subagent-1.md"]).toContain("FAIL retry.test.ts with seed 4242")
    expect(files["turn-0001.md"]).toContain("turn-0001-subagent-1.md")
    expect(files["index.md"]).toContain("find the flaky test")
  })
})
