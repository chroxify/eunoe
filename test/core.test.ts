import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { paths } from "../src/config/paths"
import { sha256 } from "../src/context/content"
import { capTurns, compactMessages } from "../src/context/fold/strategies"
import { turnFingerprint } from "../src/context/fold/turns"
import { CORE_DEFAULTS, foldThread, type Message, memoryStore, pinTurns, type RewriteInput, rewrite, rewriteAsync, threadKeyOf } from "../src/core"
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
      expect(out.note).toMatchObject({ action: "compact", cutTurn: PLAN_TURN + 1, pinned: 1, folded: 5, omitted: 0, host: true })
    })
  }

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
