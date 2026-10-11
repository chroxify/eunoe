import { homedir } from "node:os"
import path from "node:path"

export const BLOCKING_LIMIT_ENV = "CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE"
export const BLOCKING_LIMIT_OFF = "1000000000"

export const LAUNCHD_LABEL = "com.chroxify.eunoe"

export const LAUNCH_AGENT_PLIST = path.join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)

export const START_TIMEOUT_MS = 3_000
export const START_POLL_MS = 150

export const PROBE_TIMEOUT_MS = 800

export const RECENT_REQUESTS = 5_000

export const STATUS_WINDOW_MS = 24 * 3_600_000

export const THREAD_SUFFIX = /-[0-9a-f]{24}$/
