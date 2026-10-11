import type { OptionRow } from "./types"

export const TAGLINE = "Context management for Claude Code that never forgets what matters."
export const COMMAND_GROUPS: Array<[title: string, names: string[]]> = [
  ["Proxy", ["start", "stop", "status", "replay", "uninstall"]],
  ["Context", ["mode", "settings"]],
  ["Sessions", ["sessions", "peek", "load", "continue"]],
]
export const GLOBAL_OPTIONS: OptionRow[] = [
  ["-h, --help", "Show help for a command"],
  ["-v, --version", "Show the version"],
]
export const TOKEN_UNITS: [number, string][] = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "k"],
]
export const TYPO_DISTANCE = 2

const ESC = "\x1b"
export const KEY_SEQUENCE = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z~]|${ESC}.|[\\s\\S]`, "g")
export const ANSI_STYLE = new RegExp(`${ESC}\\[[0-9;]*m`, "g")
export const KEY_UP = "\x1b[A"
export const KEY_DOWN = "\x1b[B"
export const KEY_ENTER = ["\r", "\n"]
export const KEY_ESCAPE = ["\x1b", "\x03"]
export const KEY_BACKSPACE = ["\x7f", "\b"]
export const KEY_CLEAR = "\x15"

export const VIM_UP = "k"
export const VIM_DOWN = "j"
export const VIM_QUIT = "q"

export const CURSOR_HIDE = "\x1b[?25l"
export const CURSOR_SHOW = "\x1b[?25h"
