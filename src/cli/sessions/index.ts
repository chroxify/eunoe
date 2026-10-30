import { spawnSync } from "node:child_process"
import { claudeConfigDirs, readConfig } from "../../config"
import { FOLD_CAP_CHARS, foldedView, sourceChunks } from "../../context/fold"
import { recallFor } from "../../context/recall"
import { DEFAULT_RATIO } from "../../core/estimate"
import { continueToken } from "../../core/handoff"
import { seenSessions } from "../../proxy/sessions"
import { isSessionId } from "../../transcript/locate"
import { subagentChunks } from "../../transcript/subagents"
import { flagValues } from "../terminal/args"
import { ago, fail, tokens } from "../terminal/ui"
import { type SessionCandidate, sessionCandidates } from "./source"

const ASK_CHARS = 160

export const shortId = (sessionId: string) => sessionId.slice(0, 8)

function byPrefix<T>(input: string, items: T[], idOf: (item: T) => string): T | null {
  if (!isSessionId(input)) fail(`Not a session id: ${input}`)
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

export const candidatesHere = () => sessionCandidates(process.env.CLAUDE_CODE_SESSION_ID ?? "", process.cwd(), claudeConfigDirs(readConfig()))

export function candidateOf(input: string | undefined, candidates: SessionCandidate[]): SessionCandidate {
  if (!input) fail("Say which session: eunoe sessions lists them.")
  return byPrefix(input, candidates, (cand) => cand.id) ?? fail(`No earlier session ${input} in this directory.`, "eunoe sessions lists them.")
}

const tokensOf = (cand: SessionCandidate) => tokens(Math.round(foldedView(cand.messages, FOLD_CAP_CHARS).length * DEFAULT_RATIO))

export const titleOf = (cand: SessionCandidate) => cand.label || shortId(cand.id)

export const metaOf = (cand: SessionCandidate) => `${cand.asks.length} turns · ~${tokensOf(cand)} tokens · ${ago(new Date(cand.mtime).toISOString())}`

export function askOf(text: string | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim()
  if (flat.length <= ASK_CHARS) return flat
  const cut = flat.slice(0, ASK_CHARS)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), ASK_CHARS / 2))}…`
}

export const continuePrompt = (id: string) => continueToken(shortId(id))

export function copy(text: string): boolean {
  const clipboards: Array<[string, string[]]> = [
    ["pbcopy", []],
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
  ]
  return clipboards.some(([cmd, args]) => {
    const result = spawnSync(cmd, args, { input: text })
    return !result.error && result.status === 0
  })
}

export function peekText(cand: SessionCandidate, words: string): string | null {
  const chunks = [...sourceChunks(cand.messages, titleOf(cand), true), ...subagentChunks(cand.file)]
  const found = recallFor(words, chunks, { maxChars: 12_000, maxCharsMulti: 12_000, perQuery: 6, minTerms: 1 })
  if (!found) return null
  const excerpts = found.replace(/^<recalled-context>\n[^\n]*\n\n|\n<\/recalled-context>$/g, "")
  return `Excerpts of session ${shortId(cand.id)} "${titleOf(cand)}" that match "${words}", quoted exactly, oldest first:\n\n${excerpts}`
}
