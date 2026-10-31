import { describe, expect, test } from "bun:test"
import type { Body, Message } from "../src/context/content"
import { CARRIED_CHARS, compactMessages } from "../src/context/fold/strategies"
import { isPrompt, reduceTurn, splitTurns } from "../src/context/fold/turns"
import { rewrite } from "../src/proxy/rewrite"
import { call, config, freshSession, reply, result, system, transcript, user } from "./fixtures"

const body = (messages: Message[]): Body => ({ system: "s", tools: [{ name: "Bash" }], messages })
const text = (messages: Message[]) => JSON.stringify(messages)
const onDisk = (file: string) => `<system-reminder>\nNote: /repo/${file} changed on disk since you last read it. That's usually deliberate, so take it as the current state rather than reverting it.\n</system-reminder>`
const SKILLS = "<system-reminder>\nThe following skills are available: deploy, review, design\n</system-reminder>"

function reminderTurn(n: number): Message[] {
  const notes = Array.from({ length: 75 }, (_, i) => ({ type: "text", text: onDisk(`src/file-${i}.ts`) }))
  return [user(`task ${n}`), { role: "system", content: [...notes, { type: "text", text: SKILLS }] }, call(`a${n}`), result(`a${n}`, 400), reply(`answer ${n}`)]
}

describe("reminders from dropped turns", () => {
  const history = [user("first"), reply("ok"), ...Array.from({ length: 30 }, (_, i) => reminderTurn(i + 1)).flat(), user("the live one"), call("z"), result("z")]

  test("are carried once each, without the stale 'changed on disk' notes", () => {
    const { turns } = splitTurns(history)
    const out = text(compactMessages(history, turns.length - 1, { keepTurns: 0, guide: null }))
    expect(out).not.toContain("changed on disk")
    expect(out.split("The following skills are available").length).toBe(2)
  })

  test("are capped, keeping the newest", () => {
    const listings = Array.from({ length: 40 }, (_, i) => [user(`task ${i}`), system(`listing ${i} ${"l".repeat(4_000)}`), reply(`answer ${i}`)]).flat()
    const messages = [user("first"), reply("ok"), ...listings, user("live")]
    const notice = compactMessages(messages, splitTurns(messages).turns.length - 1, { keepTurns: 0, guide: null })[1]
    const carried = text([notice])
    expect(carried.length).toBeLessThan(CARRIED_CHARS + 5_000)
    expect(carried).toContain("listing 39 ")
    expect(carried).not.toContain("listing 0 ")
  })

  test("a folded turn drops its stale notes and repeats", () => {
    const folded = text(reduceTurn(reminderTurn(1)))
    expect(folded).not.toContain("changed on disk")
    expect(folded).toContain("The following skills are available")
  })

  test("a long session full of them, as on Oct 30, fits after one cut instead of getting stuck", () => {
    const out = rewrite({ body: body(history), sessionId: freshSession(), config: config({ mode: "compact" }), transcript, window: 100_000, mayCompact: true })
    expect(out.note.compacted).toBe(true)
    expect(out.note.stuck).toBeUndefined()
    expect(out.note.actions).not.toContain("stuck")
    expect(out.note.estimate as number).toBeLessThan(0.9 * 100_000)
  })
})

describe("a thread that cannot get under the target", () => {
  const WINDOW = 200_000
  const settings = config({ mode: "compact", eval: { recall: false } })
  const earlier = [user("first"), reply("ok"), user("task 1"), call("a1"), result("a1"), reply("answer 1")]
  const live = (pairs: number) => [user(`the live one ${"p".repeat(650_000)}`), ...Array.from({ length: pairs }, (_, i) => [call(`z${i}`), result(`z${i}`, 3_000)]).flat()]
  const send = (sessionId: string, pairs: number) => rewrite({ body: body([...earlier, ...live(pairs)]), sessionId, config: settings, transcript, window: WINDOW, mayCompact: true })

  test("reports stuck with where the size sits", () => {
    const out = send(freshSession(), 30)
    const stuck = out.note.stuck as Record<string, number>
    expect(stuck.live).toBeGreaterThan(0.8 * WINDOW)
    expect(stuck.live).toBeGreaterThan(stuck.head + stuck.folded)
  })

  test("keeps the cleared set where it is from one request to the next, so the cache holds", () => {
    const sessionId = freshSession()
    const outs = Array.from({ length: 6 }, (_, i) => send(sessionId, 30 + i))
    expect(new Set(outs.map((o) => o.note.cleared)).size).toBe(1)
    for (let i = 1; i < outs.length; i += 1) {
      const before = outs[i - 1].body.messages
      expect(text(outs[i].body.messages.slice(0, before.length))).toBe(text(before))
    }
  })

  test("clears again only once it has grown by a tenth of the window", () => {
    const sessionId = freshSession()
    const cleared = Array.from({ length: 40 }, (_, i) => send(sessionId, 30 + i).note.cleared)
    expect(new Set(cleared).size).toBeLessThanOrEqual(3)
    expect(cleared.at(-1)).toBeGreaterThan(cleared[0] as number)
  })
})

describe("image notes", () => {
  const note = (size: string) => ({ role: "user", content: `[Image: original ${size}, displayed at 2000x1125. Multiply coordinates by 1.28 to map to original image.]` })

  test("are not new turns", () => {
    expect(isPrompt(note("2560x1440"))).toBe(false)
    const messages = [user("look at the screenshot"), call("r"), result("r"), note("2560x1440"), call("s"), result("s"), reply("done")]
    expect(splitTurns(messages).turns.length).toBe(1)
  })

  test("are left out of a folded turn", () => {
    const folded = text(reduceTurn([user("look"), call("r"), result("r"), note("860x9270"), reply("done")]))
    expect(folded).not.toContain("[Image: original")
  })

  test("a prompt that only mentions one is still a prompt", () => {
    expect(isPrompt(user("why does [Image: original 10x10, displayed at 10x10.] show up?"))).toBe(true)
  })
})
