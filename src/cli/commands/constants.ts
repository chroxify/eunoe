import type { Mode, Tunable } from "../../config/types"

export const MODE_DESCRIPTIONS: Record<Mode, string> = {
  default: "Recent turns whole, older turns folded; evidence and recall on",
  compact: "Claude Code as it is, only its compaction replaced",
  off: "Passthrough; Claude Code compacts on its own",
}

export const TUNABLE_DESCRIPTIONS: Record<Tunable, string> = {
  keep: "Turns kept whole at the end, in default mode",
  budget: "Tokens of older detail that trigger a fold, in default mode",
  turnCap: "A kept turn larger than this many tokens is folded at once, live turn excepted; or off",
  compactAt: "Share of the context window that triggers the cut",
  keepTurns: "Earlier turns kept after a cut",
  search: "How transcripts are written for the agent to search",
  rerank: "Typesafe model that reorders recall, or off",
}
export const TUNABLE_HINTS: Record<Tunable, string> = {
  keep: "a whole number, 1 or more",
  budget: "a token count, 1000 or more",
  turnCap: "a token count, 1000 or more, or off",
  compactAt: "a number above 0, up to 1",
  keepTurns: "a whole number or all",
  search: "markdown, xml, jsonl or qmd",
  rerank: "a model name such as jev-preview, or off",
}

export const SETTING_RESET = "default"

export const SESSIONS_SHOWN = 5

export const ASK_INDENT = 6
export const ASK_MIN_WIDTH = 40
export const ASK_MAX_WIDTH = 100
