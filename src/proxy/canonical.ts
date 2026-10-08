import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Body } from "../context/types"
import { BILLING_LINE } from "./constants"
import type { Canonical, CanonicalResult } from "./types"

const billingLine = (system: Body["system"]) => {
  const first = Array.isArray(system) ? String(system[0]?.text ?? "") : String(system ?? "")
  return first.match(BILLING_LINE)?.[0] ?? null
}

function withBilling(system: Body["system"], line: string | null): Body["system"] {
  if (!line) return system
  if (Array.isArray(system)) {
    const [first, ...rest] = system
    return [{ ...first, text: String(first?.text ?? "").replace(BILLING_LINE, line) }, ...rest]
  }
  return String(system ?? "").replace(BILLING_LINE, line)
}

export function applyCanonical(body: Body, file: string): CanonicalResult {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return { body, status: "skipped" }
  if (existsSync(file)) {
    const canonical = JSON.parse(readFileSync(file, "utf8")) as Canonical
    return { body: { ...body, system: withBilling(canonical.system, billingLine(body.system)), tools: canonical.tools }, status: "applied" }
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const partial = `${file}.${process.pid}.${Date.now()}`
  writeFileSync(partial, JSON.stringify({ system: body.system, tools: body.tools } satisfies Canonical))
  renameSync(partial, file)
  return { body, status: "captured" }
}
