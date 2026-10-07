export const HEALTH_PATH = "/_eunoe/health"
export const SESSION_HEADER = "x-claude-code-session-id"
export const TRANSCRIPT_HEADER = "x-eunoe-transcript"
export const OMITTED_BEFORE_HEADER = "x-eunoe-omitted-before"

export const TARGET_SHARE = 0.3
export const PROTECTED_OUTPUTS = 5

export const DEFAULT_RATIO = 1 / 3.6
export const MEDIA_CHARS = 5_800
export const MEDIA_MIN_LENGTH = 2_000

export const MODEL_HEADERS = ["authorization", "x-api-key", "anthropic-version", "anthropic-beta"]
export const ANTHROPIC_VERSION = "2023-06-01"
export const MODEL_LOOKUP_TIMEOUT_MS = 5_000

export const MAX_EVENT_BUFFER = 4_000_000
export const LOGGED_ERROR_CHARS = 500
export const IDLE_TIMEOUT_SECONDS = 255
