import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type LiveSession, listLiveSessions, unroutedSessions } from "../src/cli/proxy/live"

const startedAt = Date.parse("2026-10-12T10:00:00.000Z")
const session = (sessionId: string, overrides: Partial<LiveSession> = {}): LiveSession => ({ pid: 1, sessionId, cwd: "/repo", startedAt, status: "idle", entrypoint: "sdk-ts", ...overrides })
const all = () => true

describe("unrouted live sessions", () => {
  test("a session the proxy never saw is unrouted", () => {
    expect(unroutedSessions([session("a")], new Map(), all, undefined).map((s) => s.sessionId)).toEqual(["a"])
  })

  test("a session seen since it started is already routed", () => {
    const seen = new Map([["a", "2026-10-12T10:05:00.000Z"]])
    expect(unroutedSessions([session("a")], seen, all, undefined)).toEqual([])
  })

  test("a session seen only before its process started needs a restart", () => {
    const seen = new Map([["a", "2026-10-12T09:00:00.000Z"]])
    expect(unroutedSessions([session("a")], seen, all, undefined).map((s) => s.sessionId)).toEqual(["a"])
  })

  test("the session running the command and unmanaged sessions are skipped", () => {
    const live = [session("self"), session("off"), session("b")]
    expect(unroutedSessions(live, new Map(), (id) => id !== "off", "self").map((s) => s.sessionId)).toEqual(["b"])
  })
})

describe("listing live sessions", () => {
  test("pid files whose process is gone or malformed are ignored", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eunoe-live-"))
    mkdirSync(path.join(dir, "sessions"))
    writeFileSync(path.join(dir, "sessions", "999999.json"), JSON.stringify(session("gone", { pid: 999_999 })))
    writeFileSync(path.join(dir, "sessions", "12.json"), "{not json")
    writeFileSync(path.join(dir, "sessions", "12.abc.key"), "x")
    expect(listLiveSessions([dir, path.join(dir, "missing")])).toEqual([])
  })
})
