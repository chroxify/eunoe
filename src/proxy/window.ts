import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { EUNOE_DIR, paths } from "../config/paths"
import { createWindowLookup } from "../core/window"

function readCache(): Map<string, number> {
  try {
    return new Map(existsSync(paths.models) ? Object.entries(JSON.parse(readFileSync(paths.models, "utf8"))) : [])
  } catch {
    return new Map()
  }
}

function saveCache(windows: Map<string, number>) {
  mkdirSync(EUNOE_DIR, { recursive: true })
  writeFileSync(paths.models, JSON.stringify(Object.fromEntries(windows), null, 2))
}

export const resolveWindow = createWindowLookup({ known: readCache(), onLearn: saveCache })
