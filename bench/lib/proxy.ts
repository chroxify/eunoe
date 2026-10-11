import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ArmSpec } from "../arms"
import { TYPESAFE_KEY_FILE } from "./constants"

const rerankEnv = () => (process.env.TYPESAFE_API_KEY ? {} : existsSync(TYPESAFE_KEY_FILE) ? { TYPESAFE_API_KEY: readFileSync(TYPESAFE_KEY_FILE, "utf8").trim() } : {})

export function startProxies(specs: ArmSpec[], dir: string, base: Record<string, unknown> = {}) {
  const seen = new Set<string>()
  return specs
    .filter((s) => !seen.has(s.proxy) && seen.add(s.proxy))
    .map((s) => {
      const home = path.join(dir, s.proxy)
      mkdirSync(home, { recursive: true })
      writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: s.port, ...base, ...s.config, eval: { trustHeaders: true, ...((s.config as any).eval ?? {}) } }))
      return Bun.spawn(["bun", path.join(import.meta.dir, "..", "..", "src", "cli", "main.ts"), "serve"], {
        env: { ...process.env, ...rerankEnv(), EUNOE_DIR: home },
        stdout: Bun.file(path.join(home, "serve.log")),
        stderr: Bun.file(path.join(home, "serve.log")),
      })
    })
}

export function proxyRequests(dir: string, proxy: string, sessionId: string): any[] {
  const file = path.join(dir, proxy, "requests.jsonl")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => String(r.thread ?? "").startsWith(sessionId) || r.context?.session === sessionId)
}
