import { describe, expect, test } from "bun:test"
import { isPrompt, splitTurns, turnFingerprint } from "../src/context/fold/turns"
import type { Body, Message } from "../src/context/types"
import { DEFAULT_RATIO } from "../src/proxy/constants"
import { sizeOf } from "../src/proxy/estimate"
import { messageFingerprint, rewrite } from "../src/proxy/rewrite"
import { readState, saveState } from "../src/proxy/state"
import { call, config, freshSession, reply, result, user } from "./fixtures"

const WINDOW = 100_000
const LIMIT = 0.9 * WINDOW
const body = (messages: Message[]): Body => ({ system: "s", tools: [{ name: "Bash" }], messages })
const sent = (b: Body) => sizeOf(b) * DEFAULT_RATIO
const threadOf = (sessionId: string, messages: Message[]) => `${sessionId}-${turnFingerprint(splitTurns(messages).turns[0])}`
const recallOf = (chars: number) => `<recalled-context>\n${"r".repeat(chars)}\n</recalled-context>`

function sizes(seed: number) {
  let x = seed
  return () => {
    x = (x * 1103515245 + 12345) % 2 ** 31
    return [40, 400, 4_000, 20_000, 30_000][x % 5]
  }
}

describe("what is sent always fits", () => {
  test("a long chat whose kept prompts carry recall, as in the stuck Kanna chat, never goes over the line", () => {
    const sessionId = freshSession()
    const next = sizes(7)
    const messages: Message[] = [user("first"), reply("ok")]
    for (let n = 1; n <= 80; n += 1) {
      messages.push(user(`task ${n}`), call(`a${n}`), result(`a${n}`, next()), reply(`answer ${n}`))
      const live = [...messages, user(`task ${n + 1}`), call(`z${n}`), result(`z${n}`, next())]
      const thread = threadOf(sessionId, live)
      const state = readState(thread)
      const recalls = { ...state.recalls }
      for (const m of live) if (isPrompt(m)) recalls[messageFingerprint(m)] ??= recallOf(15_000)
      saveState(thread, { ...state, recalls })
      const out = rewrite({ body: body(live), sessionId, config: config({ mode: "default" }), transcript: null, window: WINDOW, mayCompact: true })
      expect(sent(out.body)).toBeLessThanOrEqual(LIMIT)
    }
  })

  test("a handoff attached to the live message is counted, so the cut makes room for it", () => {
    const sessionId = freshSession()
    const messages: Message[] = [user("first"), reply("ok")]
    for (let n = 1; n <= 20; n += 1) messages.push(user(`task ${n}`), call(`a${n}`), result(`a${n}`, 6_000), reply(`answer ${n}`))
    const live = user("{ee:continue:prior-xx-aaaaaaaa} pick it up")
    messages.push(live, call("z"), result("z", 400))
    saveState(threadOf(sessionId, messages), { handoffs: { [messageFingerprint(live)]: { label: "Earlier", source: "/nowhere.jsonl", text: "h".repeat(250_000) } } })
    const out = rewrite({ body: body(messages), sessionId, config: config({ mode: "default" }), transcript: null, window: WINDOW, mayCompact: true })
    expect(JSON.stringify(out.body.messages.at(-3))).toContain('<handoff from=\\"Earlier\\">')
    expect(sent(out.body)).toBeLessThanOrEqual(LIMIT)
  })

  test("recall too big to fit even after the cut is left out of the request rather than sent over the line", () => {
    const sessionId = freshSession()
    const messages: Message[] = [user("first"), reply("ok")]
    for (let n = 1; n <= 6; n += 1) messages.push(user(`task ${n}`), call(`a${n}`), result(`a${n}`, 400), reply(`answer ${n}`))
    const live = user("the live one")
    messages.push(live, call("z"), result("z", 400))
    saveState(threadOf(sessionId, messages), { recalls: { [messageFingerprint(live)]: recallOf(500_000) } })
    const out = rewrite({ body: body(messages), sessionId, config: config({ mode: "default" }), transcript: null, window: WINDOW, mayCompact: true })
    expect(out.note.fit).toBe("bare")
    expect(sent(out.body)).toBeLessThanOrEqual(LIMIT)
    expect(JSON.stringify(out.body)).not.toContain("<recalled-context>")
  })
})
