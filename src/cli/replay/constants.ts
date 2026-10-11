export const REPLAY_WINDOW = 1_000_000
export const REPLAY_FIXED_TOKENS = 30_000
export const REPLAY_RECALL_CHARS = 3_500
export const REPLAY_NATIVE_COMPACT_AT = 0.92
export const REPLAY_NATIVE_SUMMARY_CHARS = 30_000
export const REPLAY_CACHE_READ_WEIGHT = 0.1
export const REPLAY_CACHE_WRITE_WEIGHT = 1.25
export const REPLAY_WORKERS = 8
export const REPLAY_TOP_SESSIONS = 10

export const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/
