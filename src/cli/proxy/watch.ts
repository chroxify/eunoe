import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { claudeConfigDirs, compactionOwner } from "../../config"
import { paths } from "../../config/constants"
import type { Config } from "../../config/types"
import { editSettings, withEunoe, withoutEunoe } from "./claude-settings"
import { IDLE_WATCH, WATCH_MISSES } from "./constants"
import { probe, routedDirs } from "./inspect"
import type { Watch } from "./types"

export function readWatch(): Watch {
  try {
    return { ...IDLE_WATCH, ...JSON.parse(readFileSync(paths.watch, "utf8")) }
  } catch {
    return IDLE_WATCH
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
  saveWatch(IDLE_WATCH)
}

export function nextWatch(watch: Watch, alive: boolean, routed: string[], now: string): { watch: Watch; pause: string[]; resume: string[] } {
  if (alive) return { watch: { ...IDLE_WATCH }, pause: [], resume: watch.paused }
  if (routed.length === 0) return { watch: { ...watch, misses: 0 }, pause: [], resume: [] }
  const misses = watch.misses + 1
  if (misses < WATCH_MISSES) return { watch: { ...watch, misses }, pause: [], resume: [] }
  return { watch: { misses: 0, paused: [...new Set([...watch.paused, ...routed])], pausedAt: now }, pause: routed, resume: [] }
}

export async function runWatch(config: Config) {
  const alive = (await probe(config.port)) !== null
  const step = nextWatch(readWatch(), alive, routedDirs(config), new Date().toISOString())
  if (step.pause.length > 0) editSettings(step.pause, (settings) => withoutEunoe(settings, config.port))
  if (step.resume.length > 0)
    editSettings(
      step.resume.filter((dir) => claudeConfigDirs(config).includes(dir)),
      (settings) => withEunoe(settings, config.port, compactionOwner(config)),
    )
  saveWatch(step.watch)
  return step
}
