import { describe, expect, test } from "bun:test"
import type { Message } from "../src/context/content"
import { salientLines, turnEvidence } from "../src/context/fold/evidence"
import { trimMessages } from "../src/context/fold/strategies"
import { type RecallChunk, rank, recallChunks, recallFor, terms, warmIndex, withRecall } from "../src/context/recall"
import { CORE_DEFAULTS, rewrite as coreRewrite, foldThread, memoryStore, type ThreadStore, threadKeyOf } from "../src/core"
import { rewrite } from "../src/proxy/rewrite"
import { config, freshSession, reply, user } from "./fixtures"

const run = (id: string, command: string, output: string): Message[] => [
  { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] },
]
const DEPLOY = ["Uploading 12 files", "Total Upload: 412 KiB", "Deployment ID: dpl_qgthe6u4p7", "Published billing-staging (4.21 sec)", "done"].join("\n")
const TESTS = ["running 42 tests", "FAIL src/lease.test.ts", "  E_ZARRI_6011: lease expired", "Tests: 1 failed, 41 passed"].join("\n")

describe("tool evidence", () => {
  test("keeps the lines that carry values and errors, not the noise around them", () => {
    expect(salientLines(DEPLOY)).toEqual(["Total Upload: 412 KiB", "Deployment ID: dpl_qgthe6u4p7"])
    expect(salientLines(TESTS)).toContain("E_ZARRI_6011: lease expired")
  })

  test("a reduced turn carries its evidence; file reads are left to be read again", () => {
    const turn = [
      user("deploy it"),
      ...run("t1", "bun run deploy:staging", DEPLOY),
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "1\tconst x = 0x8f3a9c2d11" }] },
      reply("deployed"),
    ]
    const evidence = turnEvidence(turn as Message[])!
    expect(evidence).toContain("dpl_qgthe6u4p7")
    expect(evidence).not.toContain("0x8f3a9c2d11")
    const trimmed = JSON.stringify(trimMessages([...(turn as Message[]), user("next")], { evidence: true }))
    expect(trimmed).toContain("dpl_qgthe6u4p7")
    expect(JSON.stringify(trimMessages([...(turn as Message[]), user("next")]))).not.toContain("dpl_qgthe6u4p7")
  })
})

describe("recall", () => {
  const history: Message[] = [
    user("deploy billing to staging"),
    ...run("d1", "bun run deploy:staging", DEPLOY),
    reply("Deployed."),
    user("run the lease tests"),
    ...run("t1", "bun test src/lease.test.ts", TESTS),
    reply("One failure, fixed."),
    user("what deployment id did the staging deploy print?"),
  ]

  test("finds the dropped output a question is about, quoted exactly", () => {
    const text = recallFor("what deployment id did the staging deploy print?", recallChunks(history, new Map()))!
    expect(text).toContain("dpl_qgthe6u4p7")
    expect(text).toContain("[turn 1]")
    expect(text).not.toContain("E_ZARRI_6011")
  })

  test("skips output that is still in context", () => {
    expect(
      recallChunks(
        history,
        new Map([
          ["d1", DEPLOY],
          ["t1", TESTS],
        ]),
      ).filter((c) => c.call !== "agent"),
    ).toEqual([])
  })

  test("asks nothing of a prompt that matches nothing", () => {
    expect(recallFor("thanks, looks good", recallChunks(history, new Map()))).toBeNull()
  })

  test("is attached to its prompt and stays identical on every later request", () => {
    const id = freshSession()
    const cfg = config({ eval: { strategy: "trim" } })
    const first = rewrite({ body: { messages: history, tools: [{}] }, sessionId: id, config: cfg, transcript: null, window: null, mayCompact: true })
    const later = rewrite({ body: { messages: [...history, ...run("x1", "ls", "a\nb"), reply("It printed it."), user("thanks")], tools: [{}] }, sessionId: id, config: cfg, transcript: null, window: null, mayCompact: true })
    const recalledIn = (messages: Message[]) => messages.filter((m) => JSON.stringify(m).includes("<recalled-context>")).map((m) => JSON.stringify(m))
    expect(recalledIn(first.body.messages)).toHaveLength(1)
    expect(recalledIn(later.body.messages)).toEqual(recalledIn(first.body.messages))
  })

  test("only prompts carry recalls", () => {
    const out = withRecall([user("a"), reply("b")], () => "k", { k: "<recalled-context>x</recalled-context>" })
    expect(JSON.stringify(out[1])).not.toContain("recalled")
  })
})

describe("ranking a large corpus", () => {
  const words = ["lease", "deploy", "staging", "billing", "worker", "queue", "timeout", "retry", "parser", "index", "cache", "token"]
  const corpus = (n: number, seed: number): RecallChunk[] =>
    Array.from({ length: n }, (_, i) => {
      const line = Array.from({ length: 3 + ((i * seed) % 9) }, (_slot, j) => words[(i * 7 + j * seed) % words.length]).join(" ")
      return { turn: i, call: `Bash: step ${i}`, lines: [line], terms: terms(`step ${i} ${line}`) }
    })
  const reference = (query: string[], chunks: RecallChunk[], minTerms = 2) => {
    const asked = [...new Set(query)]
    const df = asked.map((term) => chunks.filter((c) => c.terms.includes(term)).length)
    const average = chunks.reduce((s, c) => s + c.terms.length, 0) / chunks.length
    const needed = Math.max(1, Math.min(minTerms, df.filter((n) => n > 0).length))
    return chunks
      .map((chunk, index) => {
        const found = asked.map((term, k) => [k, chunk.terms.filter((t) => t === term).length]).filter(([, f]) => f > 0)
        let score = 0
        for (const [k, f] of found) score += (Math.log(1 + (chunks.length - df[k] + 0.5) / (df[k] + 0.5)) * (f * 2.2)) / (f + 1.2 * (0.25 + (0.75 * chunk.terms.length) / average))
        return { index, score, matched: found.length }
      })
      .filter((hit, index) => hit.matched >= needed && hit.score > 0 && index >= 0)
      .sort((a, b) => b.score - a.score)
  }

  test("the index scores exactly as a full scan does, as the corpus grows and loses chunks", () => {
    const chunks = corpus(3_000, 5)
    const query = terms("why did the staging deploy lease timeout retry")
    expect(rank(query, chunks)).toEqual(reference(query, chunks))
    const grown = [...chunks.slice(100), ...corpus(500, 3)]
    expect(rank(query, grown)).toEqual(reference(query, grown))
    expect(rank(terms("parser cache"), grown, 1)).toEqual(reference(terms("parser cache"), grown, 1))
  })

  test("an index warmed a slice at a time ranks the same as one built at once", () => {
    const chunks = corpus(2_500, 11)
    let slices = 0
    while (!warmIndex(chunks, performance.now() - 1)) slices += 1
    expect(slices).toBeGreaterThan(100)
    const query = terms("billing worker queue token")
    expect(rank(query, chunks)).toEqual(reference(query, chunks))
  })
})

describe("recall across folds", () => {
  const settings = { ...CORE_DEFAULTS, mode: "compact" as const }
  const send = (store: ThreadStore, messages: Message[]) => coreRewrite({ body: { system: "s", tools: [{ name: "Bash" }], messages }, threadId: "t", config: settings, store, window: 1_000_000, mayCompact: true })
  const failing = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} step ${i}: ERR_${tag.toUpperCase()}_${i} failed in module ${tag}-${i} ${"detail ".repeat(20)}`).join("\n")
  const blocksIn = (messages: Message[]) => messages.filter((m) => JSON.stringify(m).includes("<recalled-context>"))
  const recalledChars = (messages: Message[]) => (JSON.stringify(messages).match(/<recalled-context>[\s\S]*?<\/recalled-context>/g) ?? []).reduce((sum, block) => sum + block.length, 0)

  test("a folded prompt's recall is retired, so only the live prompt carries one", () => {
    const store = memoryStore()
    const tags = ["alpha", "bravo", "charlie", "delta"]
    const messages: Message[] = [user("start"), reply("ok")]
    for (const [i, tag] of tags.entries()) messages.push(user(`run ${tag}`), ...run(`r${i}`, `make ${tag}`, failing(tag, 40)), reply(`ran ${tag}`))
    tags.forEach((tag, i) => {
      messages.push(user(`why did ERR_${tag.toUpperCase()}_3 fail in ${tag}?`))
      foldThread({ store, threadId: "t", messages })
      const out = send(store, messages)
      expect(blocksIn(out.body.messages)).toHaveLength(1)
      expect(JSON.stringify(blocksIn(out.body.messages)[0])).toContain(`ERR_${tag.toUpperCase()}_3`)
      expect(Object.values(store.read(threadKeyOf("t", messages) as string).recalls ?? {}).filter(Boolean)).toHaveLength(1)
      messages.push(...run(`q${i}`, "ls", "ok"), reply(`answered ${tag}`))
    })
  })

  test("the recall on the prompts still in context stays under the total", () => {
    const store = memoryStore()
    const tags = ["alpha", "bravo", "charlie", "delta"]
    const messages: Message[] = [user("start"), reply("ok")]
    for (const [i, tag] of tags.entries()) messages.push(user(`run ${tag}`), ...run(`r${i}`, `make ${tag}`, failing(tag, 400)), reply(`ran ${tag}`))
    messages.push(user("now the questions"), reply("go ahead"))
    foldThread({ store, threadId: "t", messages })
    const sizes: number[] = []
    tags.forEach((tag, i) => {
      messages.push(user(`list every ERR_${tag.toUpperCase()} failure in module ${tag} and every ${tag} step`))
      const out = send(store, messages)
      sizes.push(recalledChars(out.body.messages))
      messages.push(...run(`q${i}`, "ls", "ok"), reply(`answered ${tag}`))
    })
    expect(sizes[0]).toBeGreaterThan(12_000)
    expect(sizes[1]).toBeGreaterThan(sizes[0])
    expect(sizes[2]).toBe(sizes[1])
    expect(sizes[3]).toBe(sizes[1])
    expect(sizes[3]).toBeLessThanOrEqual(32_000)
  })
})
