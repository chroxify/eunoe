export const SUMMARY_COMMAND_CHARS = 100
export const SUMMARY_ARGUMENT_CHARS = 60
export const SUMMARY_LAST_WORDS_CHARS = 600
export const SUMMARY_CALLS_SHOWN = 20

export const CLEARED_INPUT_THRESHOLD = 2_000
export const CLEARED_INPUT_KEPT = 500

export const REMINDER_ONLY = /^\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+$/

export const REREADABLE_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "Edit", "Write", "MultiEdit", "NotebookEdit"])
export const EVIDENCE_LINES_PER_CALL = 12
export const EVIDENCE_LINE_CHARS = 220
export const EVIDENCE_TURN_CHARS = 4_000
export const EVIDENCE_SCAN_LINES = 1_000_000
export const EVIDENCE_MIN_SCORE = 2
export const EVIDENCE_RANKED = true
export const EVIDENCE_LABELS = true
export const EVIDENCE_CALL_FLOOR = 2
export const ERROR_LINE = /\b(?:error|errors|fail|fails|failed|failure|fatal|exception|panic|denied|refused|timed? ?out|traceback|cannot|unable to)\b/i
export const ERROR_CODE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b|\bSIG[A-Z]{2,}\d*\b|\b[A-Z]{2,}\d{2,}\b|\bE(?:NOENT|ACCES|PERM|EXIST|CONN(?:REFUSED|RESET|ABORTED)|PIPE|ADDRINUSE|TIMEDOUT|NOTFOUND|INVAL|BUSY|MFILE|AGAIN|HOSTUNREACH|NOTDIR|ISDIR|BADF|NOSPC|AI_[A-Z]+)\b/
export const VALUE_TOKEN = /\b[a-z]{2,}[_-](?=[a-z0-9]*\d)[a-z0-9]{6,}\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b|https?:\/\/[^\s)"']+|\b\d{4,}\b|\b\d{6,}_[a-z0-9_]{3,}\b|\bv?\d+\.\d+\.\d+\b|\b\d+(?:\.\d+)?\s?(?:ms|s|[KMGT]i?B|kB|%)(?![a-z])|\bsha\d*:[0-9a-f]+|@[a-z][\w-]+|--[a-z][\w-]*=\S+|\b\d+ (?:pass(?:ed|ing)?|fail(?:ed|ing)?|tests?|files? changed|insertions?|deletions?|rows?|errors?|warnings?)\b|[$€£]\d+(?:[.,]\d+)?|\b(?:status|HTTP\/\d(?:\.\d)?)\s*[:=]?\s*[45]\d{2}\b|\bexit(?: code| status)?\s*[:=]?\s*(?!0\b)\d{1,3}\b/i
export const ID_TOKEN = /\b[a-z]{2,}[_-](?=[a-z0-9]*\d)[a-z0-9]{6,}\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b|https?:\/\/[^\s)"']+|\b\d{6,}_[a-z0-9_]{3,}\b|\bv?\d+\.\d+\.\d+\b|\bsha\d*:[0-9a-f]+|@[a-z][\w-]+|--[a-z][\w-]*=\S+/i
export const KEY_VALUE =/^[\w .\-/()]{2,48}[:=]\s*\S/
export const VALUE_LABEL = /\b(?:ids?|hash|sha(?:256)?|checksum|trace|deploy(?:ment)?|preview|url|version|rows|p9[59]|exit(?: code)?|signal|request[_-]?id|job|migration|applied|bundle|build|status|took|updated|created)\b/i

export const RECALL_WINDOW_LINES = 6
export const RECALL_SHOWN_LINES = 8
export const RECALL_PER_QUERY = 12
export const RECALL_MAX_CHARS = 18_000
export const RECALL_MAX_CHARS_MULTI = 30_000
export const RECALL_MIN_TERMS = 2
export const RECALL_SALIENT_EXCERPT = true
export const RECALL_NARRATIVE = true
export const RECALL_LINE_CHARS = 240
export const RECALL_RERANK_CANDIDATES = 30
export const RERANK_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
export const RERANK_TIMEOUT_MS = 4_000
export const RERANK_LINE_CHARS = 240
export const BM25_K1 = 1.2
export const BM25_B = 0.75
export const STOPWORDS = new Set("the and for with that this what which when where who how was were did does done from into onto have has had you your our out not but are can could would should will just then than them they there their its it's about after before again also any each other some such only own same very more most over under while because been being into".split(" "))
