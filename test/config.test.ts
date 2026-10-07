import { describe, expect, test } from "bun:test"
import { compactionOwner, modeFor, normalizeConfig } from "../src/config"
import { config } from "./fixtures"

describe("per-session modes", () => {
  test("with scope all, every session gets the default unless it has its own mode", () => {
    const c = config({ mode: "compact", sessions: { a: "trim", b: "off", d: null } })
    expect([modeFor(c, "a"), modeFor(c, "b"), modeFor(c, "d"), modeFor(c, "x"), modeFor(c, null)]).toEqual(["trim", "off", "compact", "compact", "compact"])
  })

  test("with scope sessions, only the listed ones are managed", () => {
    const c = config({ mode: "compact", scope: "sessions", sessions: { a: null, b: "trim" } })
    expect([modeFor(c, "a"), modeFor(c, "b"), modeFor(c, "x"), modeFor(c, null)]).toEqual(["compact", "trim", "off", "off"])
  })

  test("Claude Code keeps its own compaction unless eunoe manages every session", () => {
    expect(compactionOwner(config({ mode: "compact" }))).toBe("compact")
    expect(compactionOwner(config({ mode: "compact", scope: "sessions" }))).toBe("off")
  })

  test("bad scope and session entries fall back safely", () => {
    const c = normalizeConfig({ scope: "some", sessions: { a: "trim", b: "nonsense", c: null } })
    expect(c.scope).toBe("all")
    expect(c.sessions).toEqual({ a: "trim", c: null })
  })
})
