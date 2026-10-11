import { describe, expect, test } from "bun:test"
import { foldedTurns, foldedView, sourceChunks } from "../src/context/fold"
import { recallFor } from "../src/context/recall"
import type { Message } from "../src/context/types"
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
