import { homedir } from "node:os"
import path from "node:path"
import type { Mode, Tunable } from "../config/types"
import type { OptionRow } from "./types"

export const TAGLINE = "Context management for Claude Code that never forgets what matters."

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

export const GLOBAL_OPTIONS: OptionRow[] = [
  ["-h, --help", "Show help for a command"],
  ["-v, --version", "Show the version"],
]

export const LAUNCHD_LABEL = "com.chroxify.eunoe"
export const LAUNCH_AGENT_PLIST = path.join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)

export const PROBE_TIMEOUT_MS = 800
export const RECENT_REQUESTS = 5_000
export const STATUS_WINDOW_MS = 24 * 3_600_000
export const TYPO_DISTANCE = 2
export const SHORT_ID_LENGTH = 8
export const SESSIONS_SHOWN = 5

export const TRANSPARENT_PIXEL = "."
export const HALF_BLOCKS = " ▀▄█"
export const OCTANTS = [..." 𜺨𜺫🮂𜴀▘𜴁𜴂𜴃𜴄▝𜴅𜴆𜴇𜴈▀𜴉𜴊𜴋𜴌🯦𜴍𜴎𜴏𜴐𜴑𜴒𜴓𜴔𜴕𜴖𜴗𜴘𜴙𜴚𜴛𜴜𜴝𜴞𜴟🯧𜴠𜴡𜴢𜴣𜴤𜴥𜴦𜴧𜴨𜴩𜴪𜴫𜴬𜴭𜴮𜴯𜴰𜴱𜴲𜴳𜴴𜴵🮅𜺣𜴶𜴷𜴸𜴹𜴺𜴻𜴼𜴽𜴾𜴿𜵀𜵁𜵂𜵃𜵄▖𜵅𜵆𜵇𜵈▌𜵉𜵊𜵋𜵌▞𜵍𜵎𜵏𜵐▛𜵑𜵒𜵓𜵔𜵕𜵖𜵗𜵘𜵙𜵚𜵛𜵜𜵝𜵞𜵟𜵠𜵡𜵢𜵣𜵤𜵥𜵦𜵧𜵨𜵩𜵪𜵫𜵬𜵭𜵮𜵯𜵰𜺠𜵱𜵲𜵳𜵴𜵵𜵶𜵷𜵸𜵹𜵺𜵻𜵼𜵽𜵾𜵿𜶀𜶁𜶂𜶃𜶄𜶅𜶆𜶇𜶈𜶉𜶊𜶋𜶌𜶍𜶎𜶏▗𜶐𜶑𜶒𜶓▚𜶔𜶕𜶖𜶗▐𜶘𜶙𜶚𜶛▜𜶜𜶝𜶞𜶟𜶠𜶡𜶢𜶣𜶤𜶥𜶦𜶧𜶨𜶩𜶪𜶫▂𜶬𜶭𜶮𜶯𜶰𜶱𜶲𜶳𜶴𜶵𜶶𜶷𜶸𜶹𜶺𜶻𜶼𜶽𜶾𜶿𜷀𜷁𜷂𜷃𜷄𜷅𜷆𜷇𜷈𜷉𜷊𜷋𜷌𜷍𜷎𜷏𜷐𜷑𜷒𜷓𜷔𜷕𜷖𜷗𜷘𜷙𜷚▄𜷛𜷜𜷝𜷞▙𜷟𜷠𜷡𜷢▟𜷣▆𜷤𜷥█"]
export const OCTANT_TERMINALS = ["ghostty"]
export const START_TIMEOUT_MS = 3_000
export const START_POLL_MS = 150
