import { describe, expect, test } from "bun:test"
import { CLEARED_OUTPUT } from "../src/context/prompts"
import { appendSystem, clearToolResults, compactMessages, countToolResults, tailMessages, trimMessages } from "../src/context/strategies"
import { isPrompt, reduceTurn, splitTurns, turnFingerprint } from "../src/context/turns"
import type { Message } from "../src/context/types"
import { call, reply, result, system, turn, user } from "./fixtures"

const text = (messages: Message[]) => JSON.stringify(messages)

describe("turns", () => {
  test("a turn starts at a user prompt; tool results never open one", () => {
    expect(isPrompt(user("hi"))).toBe(true)
    expect(isPrompt(result("x"))).toBe(false)
    expect(splitTurns([...turn(1), ...turn(2)]).turns.map((t) => t.length)).toEqual([4, 4])
  })

  test("an interruption marker and the next prompt belong to the same turn", () => {
    const { turns } = splitTurns([...turn(1, { done: false }), user("[Request interrupted by user]"), user("do this instead"), reply("ok")])
    expect(turns).toHaveLength(2)
    expect(turns[1]).toHaveLength(3)
  })

  test("a turn's fingerprint ignores cache breakpoints", () => {
    const plain = [user("hello")]
    const marked: Message[] = [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }]
    expect(turnFingerprint(marked)).toBe(turnFingerprint(plain))
  })

  test("a finished turn reduces to its prompt and the text of its final reply, without thinking", () => {
    expect(reduceTurn(turn(1))).toEqual([user("task 1"), { role: "assistant", content: [{ type: "text", text: "answer 1" }] }])
  })

  test("an interrupted turn keeps its last words and its tool calls instead of a stray narration", () => {
    const reduced = text(reduceTurn(turn(1, { done: false })))
    expect(reduced).toContain("interrupted before a final reply")
    expect(reduced).toContain("Last thing you said: step a1")
    expect(reduced).toContain("Bash `ls`")
  })
})

describe("trim", () => {
  test("reduces every finished turn, keeps the live one whole, and grows append-only", () => {
    const two = trimMessages([...turn(1), ...turn(2, { done: false })])
    const three = trimMessages([...turn(1), ...turn(2), ...turn(3, { done: false })])
    expect(two.slice(0, 2)).toEqual(three.slice(0, 2))
    expect(three.slice(-3)).toEqual(turn(3, { done: false }))
    expect(text(three.slice(0, -3))).not.toContain("tool_use")
  })
})

describe("compact", () => {
  const history = [...turn(0), ...turn(1), ...turn(2), ...turn(3), ...turn(4, { done: false })]

  test("first message, a notice, the kept turns reduced, then the cut turn untouched", () => {
    const out = compactMessages(history, 4, { keepTurns: 2, guide: "see /t.jsonl" })
    expect(out[0]).toEqual(user("task 0"))
    expect(text([out[1]])).toContain("/t.jsonl")
    expect(text([out[1]])).toContain("1 of the oldest turns didn't fit")
    expect(out.slice(2, 6).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(text(out.slice(2, 6))).toContain("answer 2")
    expect(text(out.slice(2, 6))).not.toContain("tool_use")
    expect(out.slice(6)).toEqual(turn(4, { done: false }))
  })

  test("keeping every turn says so in the notice", () => {
    expect(text(compactMessages(history, 4, { keepTurns: Infinity, guide: null }))).toContain("Every earlier turn is shown below")
  })

  test("a cut is byte-stable as turns are added after it (the prompt cache holds)", () => {
    const base = [...turn(0), ...turn(1), ...turn(2)]
    const a = text(compactMessages([...base, ...turn(3, { done: false })], 2, { keepTurns: 5, guide: null }))
    const b = text(compactMessages([...base, ...turn(3), ...turn(4, { done: false })], 2, { keepTurns: 5, guide: null }))
    expect(b.startsWith(a.slice(0, -200))).toBe(true)
  })
})

describe("harness system messages", () => {
  const t0 = [user("task 0"), system("hook"), call("t0"), result("t0"), system("mcp instructions"), reply("answer 0")]
  const history = [...t0, ...turn(1), ...turn(2), ...turn(3, { done: false })]

  test("survive trim and compaction", () => {
    expect(text(trimMessages(history))).toContain("mcp instructions")
    const compacted = compactMessages(history, 3, { keepTurns: 1, guide: null })
    expect(text(compacted)).toContain("mcp instructions")
    expect(text(compacted)).not.toContain("answer 0")
  })

  test("only ever sit right before an assistant message, as the API requires", () => {
    for (const out of [trimMessages(history), compactMessages(history, 3, { keepTurns: 1, guide: null })]) {
      out.forEach((m, i) => {
        if (m.role === "system") expect(i === out.length - 1 || out[i + 1].role === "assistant").toBe(true)
      })
    }
  })
})

describe("tail", () => {
  test("keeps the first message and the newest turns unchanged, dropping the oldest whole", () => {
    const history = [...turn(0), ...turn(1), ...turn(2), ...turn(3, { done: false })]
    const out = tailMessages(history, 2, null)
    expect(out[0]).toEqual(user("task 0"))
    expect(text(out)).toContain("1 earlier turn was dropped")
    expect(text(out)).not.toContain("task 1")
    expect(out.slice(2)).toEqual([...turn(2), ...turn(3, { done: false })])
  })
})

describe("clearing tool output", () => {
  test("clears the oldest outputs, keeps every call, and shortens huge inputs", () => {
    const messages = [user("go"), call("a", { content: "y".repeat(5_000) }), result("a", 100), call("b"), result("b", 100)]
    expect(countToolResults(messages, 0)).toBe(2)
    const out = clearToolResults(messages, 0, 1, CLEARED_OUTPUT)
    expect(text(out)).toContain(CLEARED_OUTPUT)
    expect(text(out)).toContain("step a")
    expect(text(out)).toContain("chars cleared")
    expect(out[4]).toEqual(result("b", 100))
  })
})

test("system append moves the last cache breakpoint onto the new block", () => {
  const out = appendSystem([{ type: "text", text: "a" }, { type: "text", text: "b", cache_control: { type: "ephemeral" } }], "c")
  expect(out).toEqual([{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "text", text: "c", cache_control: { type: "ephemeral" } }])
})
