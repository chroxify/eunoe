import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { paths } from "../config/paths"
import type { ThreadState, ThreadStore } from "../core/state"

function stateFile(key: string) {
  return path.join(paths.threads, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)
}

const KEPT_THREADS = 64

const known = new Map<string, { version: string; state: ThreadState }>()

function versionOf(file: string): string | null {
  try {
    const { mtimeMs, size } = statSync(file)
    return `${mtimeMs}:${size}`
  } catch {
    return null
  }
}

function remember(file: string, version: string, state: ThreadState) {
  known.delete(file)
  known.set(file, { version, state })
  if (known.size > KEPT_THREADS) known.delete(known.keys().next().value as string)
}

export function readState(key: string): ThreadState {
  const file = stateFile(key)
  const version = versionOf(file)
  if (version === null) return {}
  const hit = known.get(file)
  if (hit?.version === version) return structuredClone(hit.state)
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as ThreadState
    remember(file, version, state)
    return structuredClone(state)
  } catch {
    return {}
  }
}

export function saveState(key: string, state: ThreadState) {
  mkdirSync(paths.threads, { recursive: true })
  const file = stateFile(key)
  writeFileSync(file, JSON.stringify(state))
  const version = versionOf(file)
  if (version !== null) remember(file, version, structuredClone(state))
}

export const fileStore: ThreadStore = { read: readState, save: saveState }
