import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { paths } from "../config/paths"

export interface Handoff {
  label: string
  source: string
  text: string
}

export interface ThreadState {
  handoffs?: Record<string, Handoff | null>
  cut?: string
  keep?: number
  cleared?: number
  ratio?: number
  recalls?: Record<string, string>
}

function stateFile(key: string) {
  return path.join(paths.threads, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)
}

export function readState(key: string): ThreadState {
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
