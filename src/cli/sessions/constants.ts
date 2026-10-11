export const LIVE_SESSION_ENV = "CLAUDE_CODE_SESSION_ID"

export const SHORT_ID_LENGTH = 8
export const UNTITLED = "untitled"

export const SESSION_SOURCE_MIN_TURNS = 2
export const SESSION_SOURCE_CANDIDATES = 12
export const SESSION_OUTLINE_CHARS = 240
export const SESSION_MIN_TERMS = 2

export const INJECTED_TAGS = /<[a-z-]+(?:\s[^>]*)?>[\s\S]*?<\/[a-z-]+>/g

export const FOLD_CAP_CHARS = 400_000

export const PEEK_STRIP = /^<recalled-context>\n[^\n]*\n\n|\n<\/recalled-context>$/g
export const PEEK_CHARS = 12_000
export const PEEK_PER_QUERY = 6
export const PEEK_MIN_TERMS = 1
export const CLIPBOARDS: Array<[string, string[]]> = [
  ["pbcopy", []],
  ["wl-copy", []],
  ["xclip", ["-selection", "clipboard"]],
]

export const ASK_CHARS = 160

export const BROWSE_ROWS = 7
export const BROWSE_MIN_COLUMNS = 60
export const BROWSE_DEFAULT_COLUMNS = 100
