import { describe, expect, test } from "bun:test"
import { pickRecallWith, recallChunks } from "../src/context/recall"
import { jevReranker, orderByProbability } from "../src/context/rerank"
import type { Message, Reranker } from "../src/context/types"
import { prefetchRecall, rewrite } from "../src/proxy/rewrite"
import { config, freshSession, reply, user } from "./fixtures"

const run = (id: string, command: string, output: string): Message[] => [
  { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] },
]
const history: Message[] = [
  user("deploy staging"),
  ...run("d1", "bun run deploy:staging", "Uploading\nDeployment ID: dpl_first111\ndone"),
  reply("deployed"),
  user("deploy again"),
  ...run("d2", "bun run deploy:staging", "Uploading\nDeployment ID: dpl_second222\ndone"),
  reply("deployed again"),
  user("what was the deployment id of the first deploy"),
]

describe("reranked recall", () => {
  test("orders by the reranker's probabilities, stable on ties", () => {
    expect(orderByProbability([7, 3, 9], { "0": 0.1, "1": 0.8, "2": 0.1 })).toEqual([3, 7, 9])
  })

  test("the reranker's order decides which chunks are injected", async () => {
    const chunks = recallChunks(history, new Map())
    const reversed: Reranker = async (_q, _c, candidates) => [...candidates].reverse()
    const picks = await pickRecallWith("deployment id of the first deploy", chunks, reversed, { perQuery: 1 })
    const bm25First = (await pickRecallWith("deployment id of the first deploy", chunks, async (_q, _c, c) => c, { perQuery: 1 }))[0].index
    expect(picks).toHaveLength(1)
    expect(picks[0].index).not.toBe(bm25First)
  })

  test("an unreachable reranker falls back to the lexical order", async () => {
    const chunks = recallChunks(history, new Map())
    const rerank = jevReranker("jev-preview", "nokey", "http://127.0.0.1:9/systemone")
    const candidates = chunks.map((_, i) => i)
    expect(await rerank("first deploy", chunks, candidates)).toEqual(candidates)
  })

  test("prefetch stores the reranked recall so the sync rewrite injects it", async () => {
    const id = freshSession()
    const cfg = config({ eval: { strategy: "trim", rerank: { model: "jev-preview" } } })
    const input = { body: { messages: history, tools: [{}] }, sessionId: id, config: cfg, transcript: null, window: null, mayCompact: true }
    const calls: string[] = []
    const spy: Reranker = async (query, _c, candidates) => { calls.push(query); return candidates }
    expect(await prefetchRecall(input, spy)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(await prefetchRecall(input, spy)).toBe(false)
    const out = rewrite(input)
    expect(JSON.stringify(out.body.messages)).toContain("<recalled-context>")
    expect(JSON.stringify(out.body.messages)).toContain("dpl_first111")
  })
})
