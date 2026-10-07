import { appendFileSync, mkdirSync } from "node:fs"
import { EUNOE_DIR, paths } from "../config/constants"

export function logRequest(record: Record<string, unknown>) {
  try {
    mkdirSync(EUNOE_DIR, { recursive: true })
    appendFileSync(paths.requests, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n")
  } catch {}
}
