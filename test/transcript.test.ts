import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { claudeConfigDirs, normalizeConfig } from "../src/config"
import { findSessionFile } from "../src/transcript/locate"
import { renderTranscript } from "../src/transcript/render"
import { prepareTranscript, searchGuide } from "../src/transcript/search"

function writeSession(dir: string, id: string) {
  const project = path.join(dir, "projects", "-tmp-project")
  mkdirSync(project, { recursive: true })
  const entries = [
    { type: "user", uuid: "1", parentUuid: null, timestamp: "2026-10-07T10:00:00Z", message: { role: "user", content: "deploy to staging yourself from now on" } },
    { type: "assistant", uuid: "2", parentUuid: "1", message: { role: "assistant", content: [{ type: "text", text: "Deploying." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "wrangler deploy" } }] } },
    { type: "user", uuid: "3", parentUuid: "2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Current Version ID: 98330153" }] } },
    { type: "assistant", uuid: "4", parentUuid: "3", message: { role: "assistant", content: [{ type: "text", text: "Deployed version 98330153." }] } },
  ]
  const file = path.join(project, `${id}.jsonl`)
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n")
  return file
}

describe("finding a session", () => {
  test("in any configured Claude config dir, not only ~/.claude", () => {
    const extra = mkdtempSync(path.join(tmpdir(), "eunoe-account-"))
    const file = writeSession(extra, "abc-123")
    const dirs = claudeConfigDirs(normalizeConfig({ claudeConfigDirs: [extra] }))
    expect(dirs).toContain(extra)
    expect(findSessionFile("abc-123", dirs)).toBe(file)
    expect(findSessionFile("missing", dirs)).toBeNull()
  })

  test("refuses session ids that could escape the projects dir", () => {
    expect(findSessionFile("../../etc/passwd", ["/"])).toBeNull()
  })
})

describe("rendering", () => {
  const sessionFile = writeSession(mkdtempSync(path.join(tmpdir(), "eunoe-src-")), "render-1")

  test("markdown: an index line per turn and every tool call with its output", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eunoe-md-"))
    const out = renderTranscript(sessionFile, "render-1", dir, "markdown")
    expect(out.turns).toBe(1)
    expect(readFileSync(path.join(dir, "index.md"), "utf8")).toContain("deploy to staging yourself")
    const turn = readFileSync(path.join(dir, "turn-0001.md"), "utf8")
    expect(turn).toContain("[tool 1/1] Bash")
    expect(turn).toContain("Current Version ID: 98330153")
    expect(turn).toContain("Deployed version 98330153.")
  })

  test("xml: the same turn as tagged elements", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eunoe-xml-"))
    renderTranscript(sessionFile, "render-1", dir, "xml")
    const turn = readFileSync(path.join(dir, "turn-0001.xml"), "utf8")
    expect(turn).toContain('<tool n="1" of="1" name="Bash">')
    expect(turn).toContain("<call>wrangler deploy</call>")
    expect(turn).toContain("<final_reply>")
  })

  test("rendering again without changes rewrites nothing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eunoe-md-"))
    expect(renderTranscript(sessionFile, "render-1", dir).changed).toBe(true)
    expect(renderTranscript(sessionFile, "render-1", dir).changed).toBe(false)
  })

  test("the search guide points at what was rendered", () => {
    const ref = prepareTranscript("markdown", sessionFile, "guide-1")
    expect(searchGuide(ref)).toContain(ref.dir)
    expect(searchGuide({ ...ref, mode: "jsonl" })).toContain(sessionFile)
  })
})

describe("config", () => {
  test("malformed fields fall back to defaults", () => {
    const config = normalizeConfig({ mode: "bogus", compactAt: 7, keepTurns: -1, search: "nope", claudeConfigDirs: "x" })
    expect(config.mode).toBe("compact")
    expect(config.compactAt).toBe(0.9)
    expect(config.keepTurns).toBe("all")
    expect(config.search).toBe("markdown")
    expect(config.claudeConfigDirs).toEqual([])
  })
})
