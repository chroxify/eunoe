import { describe, expect, test } from "bun:test"
import type { Message } from "../src/context/content"
import { foldedTurns, foldedView, sourceChunks } from "../src/context/fold"
import { splitTurns, turnFingerprint, turnKeys } from "../src/context/fold/turns"
import { recallFor } from "../src/context/recall"
import { CORE_DEFAULTS, foldThread, memoryStore, pinTurns, rewrite, type ThreadStore, threadKeyOf } from "../src/core"
import { reply, user } from "./fixtures"

const run = (id: string, command: string, output: string): Message[] => [
  { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] },
]
const DEPLOY = ["Uploading 12 files", "Deployment ID: dpl_qgthe6u4p7", "done"].join("\n")
const history: Message[] = [
  user("always use the yalsho/ branch prefix"),
  reply("Noted, yalsho/ it is."),
  user("deploy staging"),
  ...run("t1", "bun run deploy:staging", DEPLOY),
  reply("Deployed to staging."),
  user("run the tests"),
  ...run("t2", "bun test", "42 pass"),
  reply("All green."),
]

describe("fold", () => {
  test("the folded view keeps every message, the evidence and the replies", () => {
    const turns = foldedTurns(history)
    expect(turns).toHaveLength(3)
    expect(turns[1].evidence).toContain("dpl_qgthe6u4p7")
    const view = foldedView(history)
    expect(view).toContain("yalsho/")
    expect(view).toContain("dpl_qgthe6u4p7")
    expect(view).toContain("All green.")
  })

  test("a cap drops older replies and evidence but never the user's messages", () => {
    const last = foldedView(history.slice(-4))
    const view = foldedView(history, last.length + 20)
    expect(view).toContain("always use the yalsho/ branch prefix")
    expect(view).toContain("All green.")
    expect(view).not.toContain("dpl_qgthe6u4p7")
  })

  test("source chunks let recall find an earlier session's output, labelled with where it came from", () => {
    const chunks = sourceChunks(history, "previous session s01")
    const text = recallFor("what deployment id did the staging deploy print?", chunks)!
    expect(text).toContain("dpl_qgthe6u4p7")
    expect(text).toContain("[previous session s01, turn 2]")
    expect(text).toContain("earlier session on this project")
  })
})

describe("a repeated prompt", () => {
  const again = "Pull request #4 needs work: fix the review comments."
  const work = (prompt: string, id: string, output: string): Message[] => [user(prompt), ...run(id, "gh pr checks", output), reply(`done ${id}`)]
  const thread: Message[] = [
    ...work("start", "r0", "ok"),
    ...work(again, "r1", `first copy ${"x".repeat(5_000)}`),
    ...work("something else", "r2", "y".repeat(5_000)),
    ...work(again, "r3", `second copy ${"z".repeat(5_000)}`),
    user("the live one"),
  ]
  const body = (messages: Message[]) => ({ system: "s", tools: [{ name: "Bash" }], messages })
  const send = (store: ThreadStore, messages: Message[]) => rewrite({ body: body(messages), threadId: "t", config: CORE_DEFAULTS, store, window: 1_000_000, mayCompact: true })

  test("gets a key of its own for each copy, and the first copy keeps the plain fingerprint", () => {
    const turns = splitTurns(thread).turns
    expect(turnKeys(turns)).toEqual([turnFingerprint(turns[0]), turnFingerprint(turns[1]), turnFingerprint(turns[2]), `${turnFingerprint(turns[3])}~1`, turnFingerprint(turns[4])])
  })

  test("folding at the later copy cuts there, and later requests keep it there", () => {
    const store = memoryStore()
    expect(foldThread({ store, threadId: "t", messages: thread }, { at: 3 }).cutTurn).toBe(3)
    expect(send(store, thread).note.cutTurn).toBe(3)
    const grown = [...thread, ...run("r4", "ls", "ok"), reply("listed"), user("next")]
    const out = send(store, grown)
    expect(out.note.cutTurn).toBe(3)
    expect(JSON.stringify(out.body.messages)).toContain("second copy")
    expect(JSON.stringify(out.body.messages)).not.toContain("first copy")
  })

  test("a cut saved before keys had copies still resolves to the first copy", () => {
    const store = memoryStore()
    const key = threadKeyOf("t", thread) as string
    store.save(key, { cut: turnFingerprint(splitTurns(thread).turns[1]), keep: 0, host: true })
    expect(send(store, thread).note.cutTurn).toBe(1)
  })

  test("pinning the later copy keeps only that copy whole", () => {
    const store = memoryStore()
    expect(pinTurns({ store, threadId: "t", messages: thread }, [3]).pinned).toEqual([3])
    foldThread({ store, threadId: "t", messages: thread }, { at: 4 })
    const out = send(store, thread)
    expect(out.note.pinned).toBe(1)
    const sent = JSON.stringify(out.body.messages)
    expect(sent).toContain("z".repeat(5_000))
    expect(sent).not.toContain("x".repeat(5_000))
  })
})
