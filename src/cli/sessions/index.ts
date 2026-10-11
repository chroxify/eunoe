import { spawnSync } from "node:child_process"
import { claudeConfigDirs, readConfig } from "../../config"
import { SESSION_ID_PATTERN } from "../../config/constants"
import { foldedView, sourceChunks } from "../../context/fold"
import { recallFor } from "../../context/recall"
import { DEFAULT_RATIO } from "../../proxy/constants"
import { seenSessions } from "../../proxy/sessions"
import { subagentChunks } from "../../transcript/subagents"
import { flagValues } from "../terminal/args"
import { fail, tokens } from "../terminal/ui"
import { ASK_CHARS, CLIPBOARDS, FOLD_CAP_CHARS, LIVE_SESSION_ENV, PEEK_CHARS, PEEK_MIN_TERMS, PEEK_PER_QUERY, PEEK_STRIP, SHORT_ID_LENGTH } from "./constants"
import { sessionCandidates } from "./source"
import type { SessionCandidate } from "./types"

export const shortId = (sessionId: string) => sessionId.slice(0, SHORT_ID_LENGTH)

function byPrefix<T>(input: string, items: T[], idOf: (item: T) => string): T | null {
  if (!SESSION_ID_PATTERN.test(input)) fail(`Not a session id: ${input}`)
  const exact = items.find((item) => idOf(item) === input)
  if (exact) return exact
  const matches = items.filter((item) => idOf(item).startsWith(input))
  if (matches.length > 1) fail(`${input} matches ${matches.length} sessions`, "Use more of the id.")
  return matches[0] ?? null
}

export function sessionArgs(args: string[]): string[] {
  const seen = seenSessions().map(([id]) => id)
  return [...new Set(flagValues(args, "--session").map((input) => byPrefix(input, seen, (id) => id) ?? input))]
}

export function isKnown(sessionId: string) {
  return seenSessions().some(([id]) => id === sessionId)
}

export const candidatesHere = () => sessionCandidates(process.env[LIVE_SESSION_ENV] ?? "", process.cwd(), claudeConfigDirs(readConfig()))

export function candidateOf(input: string | undefined, candidates: SessionCandidate[]): SessionCandidate {
  if (!input) fail("Say which session: eunoe sessions lists them.")
  return byPrefix(input, candidates, (cand) => cand.id) ?? fail(`No earlier session ${input} in this directory.`, "eunoe sessions lists them.")
}

export const tokensOf = (cand: SessionCandidate) => tokens(Math.round(foldedView(cand.messages, FOLD_CAP_CHARS).length * DEFAULT_RATIO))

export const titleOf = (cand: SessionCandidate) => cand.label || shortId(cand.id)

export function askOf(text: string | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim()
  if (flat.length <= ASK_CHARS) return flat
  const cut = flat.slice(0, ASK_CHARS)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), ASK_CHARS / 2))}…`
}

export const continuePrompt = (id: string) => `This continues an earlier session: run \`eunoe load ${shortId(id)}\``

export function copy(text: string): boolean {
  for (const [cmd, args] of CLIPBOARDS) {
    const result = spawnSync(cmd, args, { input: text })
    if (!result.error && result.status === 0) return true
  }
  return false
}

export function peekText(cand: SessionCandidate, words: string): string | null {
  const found = recallFor(words, [...sourceChunks(cand.messages, titleOf(cand), true), ...subagentChunks(cand.file)], { maxChars: PEEK_CHARS, maxCharsMulti: PEEK_CHARS, perQuery: PEEK_PER_QUERY, minTerms: PEEK_MIN_TERMS })
  return found ? `Excerpts of session ${shortId(cand.id)} "${titleOf(cand)}" that match "${words}", quoted exactly, oldest first:\n\n${found.replace(PEEK_STRIP, "")}` : null
}
