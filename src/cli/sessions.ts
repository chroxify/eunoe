import { SESSION_ID_PATTERN } from "../config/constants"
import { seenSessions } from "../proxy/sessions"
import { flagValues } from "./args"
import { SHORT_ID_LENGTH } from "./constants"
import { fail } from "./ui"

export const shortId = (sessionId: string) => sessionId.slice(0, SHORT_ID_LENGTH)

function resolve(input: string): string {
  if (!SESSION_ID_PATTERN.test(input)) fail(`Not a session id: ${input}`)
  const seen = seenSessions().map(([id]) => id)
  if (seen.includes(input)) return input
  const matches = seen.filter((id) => id.startsWith(input))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) fail(`${input} matches ${matches.length} sessions`, "Use more of the id.")
  return input
}

export function sessionArgs(args: string[]): string[] {
  return [...new Set(flagValues(args, "--session").map(resolve))]
}

export function isKnown(sessionId: string) {
  return seenSessions().some(([id]) => id === sessionId)
}
