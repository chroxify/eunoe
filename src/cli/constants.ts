import { homedir } from "node:os"
import path from "node:path"
import type { Mode, Tunable } from "../config/types"
import type { OptionRow } from "./types"

export const THREAD_SUFFIX = /-[0-9a-f]{24}$/
export const LOGO_MISMATCH = 3 * 255 ** 2
export const SETTING_RESET = "default"

export const TAGLINE = "Context management for Claude Code that never forgets what matters."

export const BLOCKING_LIMIT_ENV = "CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE"
export const BLOCKING_LIMIT_OFF = "1000000000"

export const MODE_DESCRIPTIONS: Record<Mode, string> = {
  default: "Recent turns whole, older turns folded; evidence and recall on",
  compact: "Claude Code as it is, only its compaction replaced",
  off: "Passthrough; Claude Code compacts on its own",
}

export const TUNABLE_DESCRIPTIONS: Record<Tunable, string> = {
  keep: "Turns kept whole at the end, in default mode",
  budget: "Tokens of older detail that trigger a fold, in default mode",
  compactAt: "Share of the context window that triggers the cut",
  keepTurns: "Earlier turns kept after a cut",
  search: "How transcripts are written for the agent to search",
  rerank: "Typesafe model that reorders recall, or off",
}

export const TUNABLE_HINTS: Record<Tunable, string> = {
  keep: "a whole number, 1 or more",
  budget: "a token count, 1000 or more",
  compactAt: "a number above 0, up to 1",
  keepTurns: "a whole number or all",
  search: "markdown, xml, jsonl or qmd",
  rerank: "a model name such as jev-preview, or off",
}

export const COMMAND_GROUPS: Array<[title: string, names: string[]]> = [
  ["Proxy", ["start", "stop", "status", "uninstall"]],
  ["Context", ["mode", "settings"]],
  ["Sessions", ["sessions", "peek", "load", "continue"]],
]

export const GLOBAL_OPTIONS: OptionRow[] = [
  ["-h, --help", "Show help for a command"],
  ["-v, --version", "Show the version"],
]

export const LAUNCHD_LABEL = "com.chroxify.eunoe"
export const LAUNCH_AGENT_PLIST = path.join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)

export const PROBE_TIMEOUT_MS = 800
export const RECENT_REQUESTS = 5_000
export const TOKEN_UNITS: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]]
export const STATUS_WINDOW_MS = 24 * 3_600_000
export const TYPO_DISTANCE = 2
export const SHORT_ID_LENGTH = 8
export const LIVE_SESSION_ENV = "CLAUDE_CODE_SESSION_ID"
export const SESSIONS_SHOWN = 5
export const PEEK_STRIP = /^<recalled-context>\n[^\n]*\n\n|\n<\/recalled-context>$/g
export const PEEK_CHARS = 12_000
export const PEEK_PER_QUERY = 6
export const PEEK_MIN_TERMS = 1
export const ASK_CHARS = 160
export const ASK_INDENT = 6
export const ASK_MIN_WIDTH = 40
export const ASK_MAX_WIDTH = 100
export const UNTITLED = "untitled"
export const PICK_LABEL_CHARS = 48
export const BROWSE_ROWS = 7
export const BROWSE_MIN_COLUMNS = 60
export const BROWSE_DEFAULT_COLUMNS = 100
export const KEY_SEQUENCE = /\x1b\[[0-9;]*[A-Za-z~]|\x1b.|[\s\S]/g
export const KEY_UP = "\x1b[A"
export const KEY_DOWN = "\x1b[B"
export const KEY_ENTER = ["\r", "\n"]
export const KEY_ESCAPE = ["\x1b", "\x03"]
export const KEY_BACKSPACE = ["\x7f", "\b"]
export const KEY_CLEAR = "\x15"
export const CLIPBOARDS: Array<[string, string[]]> = [["pbcopy", []], ["wl-copy", []], ["xclip", ["-selection", "clipboard"]]]
export const PAGER = process.env.PAGER ?? "less"
export const SESSION_ACTIONS = ["continue", "peek", "load", "show"] as const

export const TRANSPARENT_PIXEL = "."
export const HALF_BLOCKS = " ▀▄█"
export const OCTANTS = [..." 𜺨𜺫🮂𜴀▘𜴁𜴂𜴃𜴄▝𜴅𜴆𜴇𜴈▀𜴉𜴊𜴋𜴌🯦𜴍𜴎𜴏𜴐𜴑𜴒𜴓𜴔𜴕𜴖𜴗𜴘𜴙𜴚𜴛𜴜𜴝𜴞𜴟🯧𜴠𜴡𜴢𜴣𜴤𜴥𜴦𜴧𜴨𜴩𜴪𜴫𜴬𜴭𜴮𜴯𜴰𜴱𜴲𜴳𜴴𜴵🮅𜺣𜴶𜴷𜴸𜴹𜴺𜴻𜴼𜴽𜴾𜴿𜵀𜵁𜵂𜵃𜵄▖𜵅𜵆𜵇𜵈▌𜵉𜵊𜵋𜵌▞𜵍𜵎𜵏𜵐▛𜵑𜵒𜵓𜵔𜵕𜵖𜵗𜵘𜵙𜵚𜵛𜵜𜵝𜵞𜵟𜵠𜵡𜵢𜵣𜵤𜵥𜵦𜵧𜵨𜵩𜵪𜵫𜵬𜵭𜵮𜵯𜵰𜺠𜵱𜵲𜵳𜵴𜵵𜵶𜵷𜵸𜵹𜵺𜵻𜵼𜵽𜵾𜵿𜶀𜶁𜶂𜶃𜶄𜶅𜶆𜶇𜶈𜶉𜶊𜶋𜶌𜶍𜶎𜶏▗𜶐𜶑𜶒𜶓▚𜶔𜶕𜶖𜶗▐𜶘𜶙𜶚𜶛▜𜶜𜶝𜶞𜶟𜶠𜶡𜶢𜶣𜶤𜶥𜶦𜶧𜶨𜶩𜶪𜶫▂𜶬𜶭𜶮𜶯𜶰𜶱𜶲𜶳𜶴𜶵𜶶𜶷𜶸𜶹𜶺𜶻𜶼𜶽𜶾𜶿𜷀𜷁𜷂𜷃𜷄𜷅𜷆𜷇𜷈𜷉𜷊𜷋𜷌𜷍𜷎𜷏𜷐𜷑𜷒𜷓𜷔𜷕𜷖𜷗𜷘𜷙𜷚▄𜷛𜷜𜷝𜷞▙𜷟𜷠𜷡𜷢▟𜷣▆𜷤𜷥█"]
export const OCTANT_TERMINALS = ["ghostty"]
export const START_TIMEOUT_MS = 3_000
export const START_POLL_MS = 150
