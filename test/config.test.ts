import { describe, expect, test } from "bun:test"
import { compactionOwner, modeFor, normalizeConfig, parseTunable, settingsFor } from "../src/config"
import { config } from "./fixtures"

describe("per-session modes", () => {
  test("with scope all, every session gets the default unless it has its own mode", () => {
    const c = config({ mode: "compact", sessions: { a: { mode: "trim" }, b: { mode: "off" }, d: {} } })
    expect([modeFor(c, "a"), modeFor(c, "b"), modeFor(c, "d"), modeFor(c, "x"), modeFor(c, null)]).toEqual(["trim", "off", "compact", "compact", "compact"])
  })

  test("with scope sessions, only the listed ones are managed", () => {
    const c = config({ mode: "compact", scope: "sessions", sessions: { a: {}, b: { mode: "trim" } } })
    expect([modeFor(c, "a"), modeFor(c, "b"), modeFor(c, "x"), modeFor(c, null)]).toEqual(["compact", "trim", "off", "off"])
  })

  test("Claude Code keeps its own compaction unless eunoe manages every session", () => {
    expect(compactionOwner(config({ mode: "compact" }))).toBe("compact")
    expect(compactionOwner(config({ mode: "compact", scope: "sessions" }))).toBe("off")
  })

  test("bad scope and session entries fall back safely", () => {
    const c = normalizeConfig({ scope: "some", sessions: { a: { mode: "trim" }, b: { mode: "nonsense", compactAt: 7 }, c: 42 } })
    expect(c.scope).toBe("all")
    expect(c.sessions).toEqual({ a: { mode: "trim" }, b: {} })
  })

  test("configs written before per-session settings still load", () => {
    const c = normalizeConfig({ sessions: { a: "trim", b: null, c: "nonsense" } })
    expect(c.sessions).toEqual({ a: { mode: "trim" }, b: {} })
  })
})

describe("per-session settings", () => {
  test("a session's own values win; everything else comes from the defaults", () => {
    const c = config({ mode: "compact", compactAt: 0.9, search: "markdown", sessions: { a: { mode: "trim", compactAt: 0.6, keepTurns: 4 } } })
    expect(settingsFor(c, "a")).toMatchObject({ mode: "trim", compactAt: 0.6, keepTurns: 4, search: "markdown" })
    expect(settingsFor(c, "b")).toMatchObject({ mode: "compact", compactAt: 0.9, keepTurns: "all", search: "markdown" })
  })

  test("invalid per-session values are dropped, valid ones kept", () => {
    const c = normalizeConfig({ sessions: { a: { compactAt: 1.5, keepTurns: "some", search: "qmd" } } })
    expect(c.sessions.a).toEqual({ search: "qmd" })
  })

  test("values typed on the command line are checked before they're saved", () => {
    expect([parseTunable("compactAt", "0.8"), parseTunable("compactAt", "2"), parseTunable("compactAt", "x")]).toEqual([0.8, null, null])
    expect([parseTunable("keepTurns", "all"), parseTunable("keepTurns", "3"), parseTunable("keepTurns", "1.5")]).toEqual(["all", 3, null])
    expect([parseTunable("search", "xml"), parseTunable("search", "html")]).toEqual(["xml", null])
  })
})
