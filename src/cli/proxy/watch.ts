import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { type Config, claudeConfigDirs, compactionOwner } from "../../config"
import { paths } from "../../config/paths"
import { editSettings, withEunoe, withoutEunoe } from "./claude-settings"
import { probe, routedDirs } from "./inspect"

interface Watch {
  misses: number
  paused: string[]
  pausedAt?: string
}

interface WatchStep {
  watch: Watch
  pause: string[]
  resume: string[]
}

export const WATCH_MISSES = 2

const idle = (): Watch => ({ misses: 0, paused: [] })

export function readWatch(): Watch {
  try {
    return { ...idle(), ...JSON.parse(readFileSync(paths.watch, "utf8")) }
  } catch {
    return idle()
  }
}

function saveWatch(watch: Watch) {
  if (watch.misses === 0 && watch.paused.length === 0) {
    if (existsSync(paths.watch)) unlinkSync(paths.watch)
    return
  }
  writeFileSync(paths.watch, `${JSON.stringify(watch, null, 2)}\n`)
}

export function clearWatch() {
  saveWatch(idle())
}

export function nextWatch(watch: Watch, alive: boolean, routed: string[], now: string): WatchStep {
  if (alive) return { watch: idle(), pause: [], resume: watch.paused }
  if (routed.length === 0) return { watch: { ...watch, misses: 0 }, pause: [], resume: [] }
  const misses = watch.misses + 1
  if (misses < WATCH_MISSES) return { watch: { ...watch, misses }, pause: [], resume: [] }
  return { watch: { misses: 0, paused: [...new Set([...watch.paused, ...routed])], pausedAt: now }, pause: routed, resume: [] }
}

export async function runWatch(config: Config): Promise<WatchStep> {
  const alive = (await probe(config.port)) !== null
  const step = nextWatch(readWatch(), alive, routedDirs(config), new Date().toISOString())
  if (step.pause.length > 0) editSettings(step.pause, (settings) => withoutEunoe(settings, config.port))
  const managed = claudeConfigDirs(config)
  const resumed = step.resume.filter((dir) => managed.includes(dir))
  if (resumed.length > 0) editSettings(resumed, (settings) => withEunoe(settings, config.port, compactionOwner(config)))
  saveWatch(step.watch)
  return step
}
