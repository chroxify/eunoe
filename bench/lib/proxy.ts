/**
 * One eunoe proxy per arm, so every arm's context is logged the same way.
 * Each proxy gets its own EUNOE_DIR under `dir/<proxy>/` with the arm's
 * config written as its config.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ArmSpec } from "../arms"

export function startProxies(specs: ArmSpec[], dir: string, base: Record<string, unknown> = {}) {
  const seen = new Set<string>()
  return specs.filter((s) => !seen.has(s.proxy) && seen.add(s.proxy)).map((s) => {
    const home = path.join(dir, s.proxy)
    mkdirSync(home, { recursive: true })
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: s.port, ...base, ...s.config, eval: { trustHeaders: true, ...((s.config as any).eval ?? {}) } }))
    return Bun.spawn(["bun", path.join(import.meta.dir, "..", "..", "src", "cli", "main.ts"), "serve"], {
      env: { ...process.env, EUNOE_DIR: home },
      stdout: Bun.file(path.join(home, "serve.log")),
      stderr: Bun.file(path.join(home, "serve.log")),
    })
  })
}

/** The requests one proxy logged for one session. */
export function proxyRequests(dir: string, proxy: string, sessionId: string): any[] {
  const file = path.join(dir, proxy, "requests.jsonl")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => String(r.thread ?? "").startsWith(sessionId) || r.context?.session === sessionId)
}
