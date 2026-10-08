import { describe, expect, test } from "bun:test"
import { rewrite } from "../src/proxy/rewrite"
import type { Body } from "../src/context/types"
import { call, config, freshSession, reply, result, session, transcript, user } from "./fixtures"

const TOOLS = [{ name: "Bash" }]
const body = (messages: Body["messages"]): Body => ({ system: "s", tools: TOOLS, messages })
const run = (b: Body, patch: Parameters<typeof config>[0] = {}, window: number | null = 100_000, sessionId = freshSession()) =>
  rewrite({ body: b, sessionId, config: config(patch), transcript, window, mayCompact: true })
const text = (b: Body) => JSON.stringify(b.messages)

describe("passthrough", () => {
  test("off mode, a missing session id, and side requests without tools are left alone", () => {
    const b = body(session(3))
    expect(run(b, { mode: "off" }).body).toBe(b)
    expect(rewrite({ body: b, sessionId: null, config: config(), transcript, window: 100_000, mayCompact: true }).body).toBe(b)
    const side = { ...b, tools: [] }
    expect(run(side, { eval: { strategy: "trim" } }).body).toBe(side)
  })
})

describe("compact", () => {
  test("below the limit, the request goes upstream byte for byte", () => {
    const b = body(session(5))
    expect(run(b).body).toBe(b)
  })

  test("at the limit, every earlier turn survives as prompt + reply and the live turn stays whole", () => {
    const out = run(body(session(20, 3_000)), { compactAt: 0.1 })
    const sent = text(out.body)
    expect(out.note.compacted).toBe(true)
    for (let i = 1; i <= 20; i += 1) {
      expect(sent).toContain(`task ${i}`)
      expect(sent).toContain(`answer ${i}`)
    }
    expect(sent).not.toContain("step a1")
    expect(sent).toContain("step z")
    expect(sent).toContain("Every earlier turn is shown below")
  })

  test("an unknown window never cuts, whatever the size", () => {
    const b = body(session(20, 20_000))
    expect(run(b, { compactAt: 0.01 }, null).body).toBe(b)
  })

  test("a 325k request on a 1M model is nowhere near the limit (live regression)", () => {
    const b = body(session(14, 80_000))
    const out = run(b, { mode: "compact" }, 1_000_000)
    expect(out.body).toBe(b)
    expect(out.note.compacted).toBe(false)
  })

  test("count_tokens applies an existing cut but never makes one", () => {
    const b = body(session(20, 3_000))
    const out = rewrite({ body: b, sessionId: freshSession(), config: config({ compactAt: 0.1 }), transcript, window: 100_000, mayCompact: false })
    expect(out.body).toBe(b)
  })

  test("the same history gives the same bytes, and grows append-only after a cut", () => {
    const id = freshSession()
    const history = session(8, 6_000)
    const a = text(run(body(history), {}, 30_000, id).body)
    const b = text(run(body(history), {}, 30_000, id).body)
    expect(a).toBe(b)
    const c = text(run(body([...history, reply("still going")]), {}, 30_000, id).body)
    expect(c.startsWith(a.slice(0, -1))).toBe(true)
  })

  test("a rewind past the cut resets it and follows what Claude Code sends", () => {
    const id = freshSession()
    const history = session(20, 3_000)
    expect(run(body(history), { compactAt: 0.1 }, 100_000, id).note.compacted).toBe(true)
    const rewound = [user("first"), reply("ok"), user("a different start")]
    const out = run(body(rewound), { compactAt: 0.1 }, 100_000, id)
    expect(out.note.cutTurn).toBeNull()
  })
})

describe("compaction under pressure", () => {
  test("a huge live turn keeps the prompt, every call, its words and the newest outputs, and lands under the limit", () => {
    const messages: Body["messages"] = [user("first"), reply("ok")]
    for (let i = 1; i <= 6; i += 1) messages.push(user(`task ${i}`), reply(`answer ${i}`))
    messages.push(user("the big one"))
    for (let i = 0; i < 30; i += 1) {
      messages.push({ role: "assistant", content: [{ type: "text", text: `step c${i}` }, { type: "tool_use", id: `c${i}`, name: "Write", input: { content: "w".repeat(5_000) } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: "o".repeat(20_000) }] })
    }
    const out = run(body(messages), { compactAt: 0.5 }, 250_000)
    const sent = text(out.body)
    expect(sent).toContain("the big one")
    for (let i = 0; i < 30; i += 1) expect(sent).toContain(`step c${i}`)
    const outputs = out.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result")
    expect(outputs.slice(-5).every((b) => b.content.length === 20_000)).toBe(true)
    expect(outputs.slice(0, 5).every((b) => String(b.content).includes("cleared"))).toBe(true)
    expect(Math.round(sent.length / 3.6)).toBeLessThan(0.5 * 250_000)
  })
})

describe("trim", () => {
  test("reduces finished turns and tells the agent where its transcript is", () => {
    const out = run(body(session(5, 3_000)), { eval: { strategy: "trim" } })
    expect(text(out.body)).not.toContain("step a1")
    expect(text(out.body)).toContain("step z")
    expect(JSON.stringify(out.body.system)).toContain("/t.jsonl")
  })
})

describe("evaluation strategies", () => {
  test("tail fills the budget a cut aims for; the cut keeps every turn and still lands under it", () => {
    const b = body(session(20, 20_000))
    const cut = run(b)
    const tail = run(b, { eval: { strategy: "tail" } })
    expect(tail.note.estimate as number).toBeLessThanOrEqual(0.9 * 100_000)
    expect(cut.note.estimate as number).toBeLessThan(tail.note.estimate as number)
    const sent = text(tail.body)
    expect(sent).toContain("first")
    expect(sent).toContain("the live one")
    expect(sent).toContain("step a20")
    expect(sent).toContain("earlier turns were dropped")
  })

  test("guide leaves the conversation untouched and only adds search instructions", () => {
    const b = body(session(5))
    const out = run(b, { eval: { strategy: "guide" } })
    expect(out.body.messages).toBe(b.messages)
    expect(JSON.stringify(out.body.system)).toContain("full transcript")
  })
})

describe("default", () => {
  const rolling = { keep: 2, budget: 5_000 }

  test("past the budget, every turn but the last few shrinks while those stay whole", () => {
    const out = run(body(session(10, 3_000)), rolling, 1_000_000)
    const sent = text(out.body)
    expect(out.note.actions).toEqual(["roll"])
    for (let i = 1; i <= 10; i += 1) expect(sent).toContain(`answer ${i}`)
    expect(sent).not.toContain("step a8")
    expect(sent).toContain("step a9")
    expect(sent).toContain("step a10")
    expect(sent).toContain("step z")
  })

  test("between rolls the request only grows at the end, so the cache keeps hitting", () => {
    const id = freshSession()
    const history = session(10, 3_000)
    const first = text(run(body(history), rolling, 1_000_000, id).body)
    const grown = run(body([...history, ...[reply("more")]]), rolling, 1_000_000, id)
    expect(grown.note.actions).toBeUndefined()
    expect(text(grown.body).startsWith(first.slice(0, -1))).toBe(true)
  })

  test("a new turn doesn't roll again until a budget's worth of older detail has built up", () => {
    const id = freshSession()
    const history = session(10, 3_000)
    run(body(history), rolling, 1_000_000, id)
    const next = run(body([...history, reply("done"), user("another"), call("y"), result("y", 3_000)]), rolling, 1_000_000, id)
    expect(next.note.actions).toBeUndefined()
  })

  test("under the budget nothing moves", () => {
    const b = body(session(3))
    expect(run(b, rolling, 1_000_000).body).toBe(b)
  })

  test("is the default, with evidence kept in folded turns and recall attached to the prompt", () => {
    const deploy: Body["messages"] = [
      user("deploy it"),
      { role: "assistant", content: [{ type: "tool_use", id: "d", name: "Bash", input: { command: "bun run deploy" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "d", content: "Uploading\nDeployment ID: dpl_qgthe6u4p7\ndone" }] },
      reply("deployed"),
    ]
    const history = [...session(6, 3_000).slice(0, -3), ...deploy, ...session(4, 3_000).slice(2, -3), user("what deployment id did the deploy print?"), call("z"), result("z")]
    const out = run(body(history), rolling, 1_000_000)
    const sent = text(out.body)
    expect(config().mode).toBe("default")
    expect(out.note.actions).toEqual(["roll"])
    expect(sent).toContain("<tool-evidence>")
    expect(sent).toContain("<recalled-context>")
    expect(sent.split("dpl_qgthe6u4p7").length).toBe(3)
    expect(text(run(body(history), { ...rolling, eval: { evidence: false, recall: false } }, 1_000_000).body)).not.toContain("dpl_qgthe6u4p7")
  })
})
