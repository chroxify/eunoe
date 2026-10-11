import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { editSettings, proxyUrl, withCompactionOwner, withEunoe, withoutEunoe } from "../src/cli/proxy/claude-settings"
import { BLOCKING_LIMIT_ENV, BLOCKING_LIMIT_OFF } from "../src/cli/proxy/constants"

describe("Claude settings edits", () => {
  test("install routes through eunoe and hands compaction to it, keeping everything else", () => {
    const out = withEunoe({ model: "opus", env: { FOO: "1" } }, 8788, "compact")
    expect(out).toEqual({ model: "opus", env: { FOO: "1", ANTHROPIC_BASE_URL: proxyUrl(8788), [BLOCKING_LIMIT_ENV]: BLOCKING_LIMIT_OFF }, autoCompactEnabled: false })
  })

  test("off hands compaction back to Claude Code, blocking limit included", () => {
    expect(withCompactionOwner({ autoCompactEnabled: false, env: { [BLOCKING_LIMIT_ENV]: BLOCKING_LIMIT_OFF } }, "off")).toEqual({})
    expect(withCompactionOwner({}, "default")).toEqual({ autoCompactEnabled: false, env: { [BLOCKING_LIMIT_ENV]: BLOCKING_LIMIT_OFF } })
  })

  test("a blocking limit the user set themselves is left alone when eunoe steps back", () => {
    expect(withCompactionOwner({ env: { [BLOCKING_LIMIT_ENV]: "500000" } }, "off")).toEqual({ env: { [BLOCKING_LIMIT_ENV]: "500000" } })
  })

  test("uninstall removes only what install added", () => {
    const installed = withEunoe({ env: { FOO: "1" } }, 8788, "compact")
    expect(withoutEunoe(installed, 8788)).toEqual({ env: { FOO: "1" } })
    expect(withoutEunoe(withEunoe({}, 8788, "compact"), 8788)).toEqual({})
  })

  test("uninstall leaves a base URL that points somewhere else alone", () => {
    const corporate = { env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" } }
    expect(withoutEunoe(corporate, 8788)).toEqual(corporate)
  })

  test("edits real files, creating settings.json if needed and skipping missing dirs", () => {
    const withFile = mkdtempSync(path.join(tmpdir(), "eunoe-cfg-"))
    const empty = mkdtempSync(path.join(tmpdir(), "eunoe-cfg-"))
    writeFileSync(path.join(withFile, "settings.json"), JSON.stringify({ theme: "dark" }))
    const touched = editSettings([withFile, empty, "/nonexistent/eunoe"], (s) => withEunoe(s, 9000, "compact"))
    expect(touched).toHaveLength(2)
    expect(JSON.parse(readFileSync(path.join(withFile, "settings.json"), "utf8"))).toEqual({ theme: "dark", env: { ANTHROPIC_BASE_URL: proxyUrl(9000), [BLOCKING_LIMIT_ENV]: BLOCKING_LIMIT_OFF }, autoCompactEnabled: false })
    expect(JSON.parse(readFileSync(path.join(empty, "settings.json"), "utf8")).env.ANTHROPIC_BASE_URL).toBe(proxyUrl(9000))
  })

  test("an edit that changes nothing doesn't rewrite the file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eunoe-cfg-"))
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ theme: "dark" }))
    expect(editSettings([dir], (s) => withoutEunoe(s, 8788))).toEqual([])
  })
})

describe("terminal output", () => {
  test("suggests the closest command for a typo, and nothing for nonsense", async () => {
    const { closest } = await import("../src/cli/terminal/ui")
    const commands = ["install", "uninstall", "stop", "mode", "status", "serve"]
    expect(closest("instal", commands)).toBe("install")
    expect(closest("stauts", commands)).toBe("status")
    expect(closest("frobnicate", commands)).toBeNull()
  })

  test("formats token counts and times for people", async () => {
    const { ago, tokens } = await import("../src/cli/terminal/ui")
    expect([tokens(950), tokens(1_234), tokens(48_000), tokens(1_250_000), tokens(31_000_000), tokens(1_520_000_000), tokens(999_950), tokens(2_400_000_000_000)]).toEqual(["950", "1.2k", "48k", "1.3M", "31M", "1.5B", "1.0M", "2.4T"])
    expect(ago(new Date(Date.now() - 2 * 3_600_000).toISOString())).toBe("2h ago")
  })
})

describe("logo", () => {
  test("pixel rows are even in count, equal in width and only use known colours", async () => {
    const { LOGO_KEYS, LOGO_PALETTE, LOGO_PIXELS } = await import("../src/cli/logo/constants")
    expect(LOGO_PIXELS.length % 4).toBe(0)
    expect(new Set(LOGO_PIXELS.map((row) => row.length)).size).toBe(1)
    expect(LOGO_KEYS.length).toBe(LOGO_PALETTE.length)
    for (const key of LOGO_PIXELS.join("").replaceAll(".", "")) expect(LOGO_KEYS).toContain(key)
  })
})
