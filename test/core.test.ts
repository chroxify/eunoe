import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { paths } from "../src/config/paths"
import { sha256 } from "../src/context/content"
import { CORE_DEFAULTS, type Message, memoryStore, type RewriteInput, rewrite, rewriteAsync, threadKeyOf } from "../src/core"
import { call, reply, result, session, user } from "./fixtures"

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
