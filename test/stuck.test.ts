import { describe, expect, test } from "bun:test"
import type { Body, Message } from "../src/context/content"
import { CARRIED_CHARS, compactMessages } from "../src/context/fold/strategies"
import { isPrompt, reduceTurn, splitTurns } from "../src/context/fold/turns"
import { CORE_DEFAULTS, rewrite as coreRewrite, memoryStore, type Rewrite, type RewriteNote, type ThreadStore, threadKeyOf } from "../src/core"
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

  test("clears again only once it would pass the window, and that clearing brings it back under", () => {
    const sessionId = freshSession()
    const outs = Array.from({ length: 40 }, (_, i) => send(sessionId, 30 + i))
    const cleared = outs.map((o) => o.note.cleared)
    expect(new Set(cleared).size).toBe(4)
    for (const out of outs) expect(out.note.estimate as number).toBeLessThanOrEqual(WINDOW)
    for (let i = 1; i < outs.length; i += 1) {
      if (cleared[i] !== cleared[i - 1]) continue
      const before = outs[i - 1].body.messages
      expect(text(outs[i].body.messages.slice(0, before.length))).toBe(text(before))
    }
  })
})

describe("stuck is only about not fitting", () => {
  const WINDOW = 20_000
  const settings = { ...CORE_DEFAULTS, mode: "compact" as const, eval: { recall: false } }
  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i} ok`).join("\n")
  const send = (store: ThreadStore, messages: Message[]) => coreRewrite({ body: body(messages), threadId: "t", config: settings, store, window: WINDOW, mayCompact: true })

  test("a cut that misses the target but fits is not stuck, then or later", () => {
    const store = memoryStore()
    const messages: Message[] = [user("Run the deploy."), call("d"), { role: "user", content: [{ type: "tool_result", tool_use_id: "d", content: lines(4_000, "build") }] }, reply("It failed."), user("Why did the deploy fail?")]
    const notes: RewriteNote[] = []
    for (let step = 0; step < 40; step += 1) {
      notes.push(send(store, messages).note)
      messages.push(call(`s${step}`), { role: "user", content: [{ type: "tool_result", tool_use_id: `s${step}`, content: lines(step % 3 === 0 ? 260 : 25, `s${step}`) }] })
    }
    const shrunk = notes.findIndex((note, i) => i > 0 && (note.actions ?? []).some((a) => a.startsWith("cleared")))
    expect(shrunk).toBeGreaterThan(0)
    expect(notes[shrunk].estimate as number).toBeLessThan(0.9 * WINDOW)
    expect(notes[shrunk].actions).not.toContain("stuck")
    for (const note of notes) expect(note.stuck).toBeUndefined()
  })

  test("a stuck thread that grows past a tenth of the window per request keeps its bytes while no clearing helps", () => {
    const store = memoryStore()
    const messages: Message[] = [user("Earlier task."), reply("Done earlier."), user("The live one.")]
    const outs: Rewrite[] = []
    for (let step = 0; step < 12; step += 1) {
      outs.push(send(store, messages))
      messages.push(call(`s${step}`), { role: "user", content: [{ type: "tool_result", tool_use_id: `s${step}`, content: `out ${step}\n${"x".repeat(20_000)}` }] })
    }
    const stuck = outs.filter((out) => out.note.stuck)
    expect(stuck.length).toBeGreaterThan(5)
    expect(new Set(stuck.map((out) => out.note.cleared)).size).toBe(1)
    for (let i = outs.indexOf(stuck[0]) + 1; i < outs.length; i += 1) {
      const before = outs[i - 1].body.messages
      expect(text(outs[i].body.messages.slice(0, before.length))).toBe(text(before))
    }
  })

  test("stuck clears once a request fits again", () => {
    const store = memoryStore()
    const big = [user("Earlier task."), reply("Done earlier."), user("The live one."), call("b"), result("b", 90_000)]
    expect(send(store, big).note.stuck).toBeDefined()
    const fits = [...big.slice(0, 3), reply("Dropped it."), user("Something small.")]
    const out = send(store, fits)
    expect(out.note.stuck).toBeUndefined()
    expect(store.read(threadKeyOf("t", fits) as string).stuck).toBeUndefined()
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
