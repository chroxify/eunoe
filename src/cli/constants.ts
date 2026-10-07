import { homedir } from "node:os"
import path from "node:path"
import type { Mode, Tunable } from "../config/types"
import type { OptionRow } from "./types"

export const TAGLINE = "Context management for Claude Code that never forgets what matters."

export const MODE_DESCRIPTIONS: Record<Mode, string> = {
  compact: "Full context until the window is nearly full, then eunoe's cut",
  trim: "Every finished turn kept as your message and the final reply",
  off: "Passthrough. Claude Code compacts on its own",
}

export const TUNABLE_DESCRIPTIONS: Record<Tunable, string> = {
  compactAt: "Share of the context window that triggers compact's cut",
  keepTurns: "Earlier turns kept after a cut",
  search: "How transcripts are written for the agent to search",
}

export const TUNABLE_HINTS: Record<Tunable, string> = {
  compactAt: "a number above 0, up to 1",
  keepTurns: "a whole number or all",
  search: "markdown, xml, jsonl or qmd",
}

export const GLOBAL_OPTIONS: OptionRow[] = [
  ["-h, --help", "Show help for a command"],
  ["-v, --version", "Show the version"],
]

export const LAUNCHD_LABEL = "com.chroxify.eunoe"
export const LAUNCH_AGENT_PLIST = path.join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)

export const PROBE_TIMEOUT_MS = 800
export const RECENT_REQUESTS = 200
export const TYPO_DISTANCE = 2
export const SHORT_ID_LENGTH = 8
export const SESSIONS_SHOWN = 5

export const TRANSPARENT_PIXEL = "."
export const HALF_BLOCKS = " ▀▄█"
export const OCTANTS = [..." 𜺨𜺫🮂𜴀▘𜴁𜴂𜴃𜴄▝𜴅𜴆𜴇𜴈▀𜴉𜴊𜴋𜴌🯦𜴍𜴎𜴏𜴐𜴑𜴒𜴓𜴔𜴕𜴖𜴗𜴘𜴙𜴚𜴛𜴜𜴝𜴞𜴟🯧𜴠𜴡𜴢𜴣𜴤𜴥𜴦𜴧𜴨𜴩𜴪𜴫𜴬𜴭𜴮𜴯𜴰𜴱𜴲𜴳𜴴𜴵🮅𜺣𜴶𜴷𜴸𜴹𜴺𜴻𜴼𜴽𜴾𜴿𜵀𜵁𜵂𜵃𜵄▖𜵅𜵆𜵇𜵈▌𜵉𜵊𜵋𜵌▞𜵍𜵎𜵏𜵐▛𜵑𜵒𜵓𜵔𜵕𜵖𜵗𜵘𜵙𜵚𜵛𜵜𜵝𜵞𜵟𜵠𜵡𜵢𜵣𜵤𜵥𜵦𜵧𜵨𜵩𜵪𜵫𜵬𜵭𜵮𜵯𜵰𜺠𜵱𜵲𜵳𜵴𜵵𜵶𜵷𜵸𜵹𜵺𜵻𜵼𜵽𜵾𜵿𜶀𜶁𜶂𜶃𜶄𜶅𜶆𜶇𜶈𜶉𜶊𜶋𜶌𜶍𜶎𜶏▗𜶐𜶑𜶒𜶓▚𜶔𜶕𜶖𜶗▐𜶘𜶙𜶚𜶛▜𜶜𜶝𜶞𜶟𜶠𜶡𜶢𜶣𜶤𜶥𜶦𜶧𜶨𜶩𜶪𜶫▂𜶬𜶭𜶮𜶯𜶰𜶱𜶲𜶳𜶴𜶵𜶶𜶷𜶸𜶹𜶺𜶻𜶼𜶽𜶾𜶿𜷀𜷁𜷂𜷃𜷄𜷅𜷆𜷇𜷈𜷉𜷊𜷋𜷌𜷍𜷎𜷏𜷐𜷑𜷒𜷓𜷔𜷕𜷖𜷗𜷘𜷙𜷚▄𜷛𜷜𜷝𜷞▙𜷟𜷠𜷡𜷢▟𜷣▆𜷤𜷥█"]
export const OCTANT_TERMINALS = ["ghostty"]
export const START_TIMEOUT_MS = 3_000
export const START_POLL_MS = 150
