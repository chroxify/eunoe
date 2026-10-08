import { describe, expect, test } from "bun:test"
import { salientLines, turnEvidence } from "../src/context/evidence"
import { recallChunks, recallFor, withRecall } from "../src/context/recall"
import { trimMessages } from "../src/context/strategies"
import type { Message } from "../src/context/types"
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
    const turn = [user("deploy it"), ...run("t1", "bun run deploy:staging", DEPLOY), { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a.ts" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "1\tconst x = 0x8f3a9c2d11" }] }, reply("deployed")]
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
    user("deploy billing to staging"), ...run("d1", "bun run deploy:staging", DEPLOY), reply("Deployed."),
    user("run the lease tests"), ...run("t1", "bun test src/lease.test.ts", TESTS), reply("One failure, fixed."),
    user("what deployment id did the staging deploy print?"),
  ]

  test("finds the dropped output a question is about, quoted exactly", () => {
    const text = recallFor("what deployment id did the staging deploy print?", recallChunks(history, new Map()))!
    expect(text).toContain("dpl_qgthe6u4p7")
    expect(text).toContain("[turn 1]")
    expect(text).not.toContain("E_ZARRI_6011")
  })

  test("skips output that is still in context", () => {
    expect(recallChunks(history, new Map([["d1", DEPLOY], ["t1", TESTS]])).filter((c) => c.call !== "agent")).toEqual([])
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
