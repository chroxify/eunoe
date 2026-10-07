import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { paths } from "../config/constants"
import type { ThreadState } from "./types"

function stateFile(key: string) {
  return path.join(paths.threads, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)
}

export function loadState(key: string): ThreadState {
  try {
    return JSON.parse(readFileSync(stateFile(key), "utf8"))
  } catch {
    return {}
  }
}

export function saveState(key: string, state: ThreadState) {
  mkdirSync(paths.threads, { recursive: true })
  writeFileSync(stateFile(key), JSON.stringify(state))
}

export function resetCut(state: ThreadState) {
  delete state.cut
  delete state.keep
  delete state.cleared
}
