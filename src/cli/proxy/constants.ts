import { homedir } from "node:os"
import path from "node:path"
import type { Agent, Watch } from "./types"

export const BLOCKING_LIMIT_ENV = "CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE"
export const BLOCKING_LIMIT_OFF = "1000000000"

const LAUNCH_AGENTS = path.join(homedir(), "Library", "LaunchAgents")

const LAUNCHD_LABEL = "com.chroxify.eunoe"
const WATCH_LABEL = "com.chroxify.eunoe.watch"

export const PROXY_AGENT: Agent = { label: LAUNCHD_LABEL, plist: path.join(LAUNCH_AGENTS, `${LAUNCHD_LABEL}.plist`), keepAlive: true }
export const WATCH_AGENT: Agent = { label: WATCH_LABEL, plist: path.join(LAUNCH_AGENTS, `${WATCH_LABEL}.plist`), interval: 10 }

export const RESTART_THROTTLE_S = 1
export const WATCH_MISSES = 2
export const BIND_RETRIES = 30
export const BIND_RETRY_MS = 1_000
export const IDLE_WATCH: Watch = { misses: 0, paused: [] }

export const START_TIMEOUT_MS = 3_000
export const START_POLL_MS = 150

export const PROBE_TIMEOUT_MS = 800

export const RECENT_REQUESTS = 5_000

export const STATUS_WINDOW_MS = 24 * 3_600_000

export const THREAD_SUFFIX = /-[0-9a-f]{24}$/
