import { readConfig } from "../../config"
import type { Command } from "../command"
import { routedDirs } from "../proxy/inspect"
import { askOf, candidatesHere, continuePrompt, copy, metaOf, shortId } from "../sessions"
import { browse, filterCandidates, UNTITLED } from "../sessions/browse"
import type { SessionCandidate } from "../sessions/source"
import { interactive } from "../terminal/prompt"
import { c, fail, line, ok, warn, wrap } from "../terminal/ui"

const INDENT = 6

const askWidth = () => Math.max(40, Math.min(100, (process.stdout.columns ?? 100 + INDENT) - INDENT - 12))

function ask(label: string, text: string | undefined) {
  const [first = "", ...rest] = wrap(askOf(text), askWidth())
  line(`${" ".repeat(INDENT)}${c.dim(label)}  ${first}`)
  for (const more of rest) line(`${" ".repeat(INDENT + label.length + 2)}${more}`)
}

function show(cand: SessionCandidate) {
  const title = cand.label ? c.bold(cand.label) : c.dim(UNTITLED)
  line(`  ${c.cyan(shortId(cand.id))}  ${title}  ${c.dim(metaOf(cand))}`)
  ask("first", cand.asks[0])
  ask("last ", cand.asks.at(-1))
  line()
}

function listSessions(words: string, candidates: SessionCandidate[]) {
  const order = filterCandidates(words, candidates)
  line()
  line(`  ${c.dim(words ? `Earlier sessions here, closest to "${words}" first` : "Earlier sessions here, newest first")}`)
  line()
  for (const cand of order) show(cand)
  if (order.length === 0) line(`  ${c.dim(`Nothing matches "${words}".`)}`)
}

function handOff(id: string) {
  const prompt = continuePrompt(id)
  line()
  ok(`${c.bold(prompt)}  ${copy(prompt) ? c.dim("copied") : ""}`)
  if (routedDirs(readConfig()).length === 0) warn("Claude Code isn't routed through eunoe, so the agent won't know to load it (eunoe start).")
  line()
}

export const sessions: Command = {
  summary: "Pick an earlier session for the agent to continue from",
  usage: "eunoe sessions [words] [--list]",
  details: [
    "Browse this directory's earlier Claude Code sessions: type to filter, pick",
    "one, and a {ee:continue:<id>} marker is copied. Paste it into any Claude Code",
    "chat along with what you want done: eunoe attaches that whole session to the",
    "message, and its dropped output stays searchable from then on. Words start",
    "the filter.",
    "",
    "--list, or a pipe, prints the sessions newest first with each one's first",
    "and last request. That is what the agent reads when it runs this itself.",
  ],
  options: [["--list", "Print the sessions instead of browsing them"]],
  async run(args) {
    const words = args
      .filter((a) => !a.startsWith("-"))
      .join(" ")
      .trim()
    const candidates = candidatesHere()
    if (candidates.length === 0) fail("No earlier sessions in this directory.")
    if (args.includes("--list") || !interactive) return listSessions(words, candidates)
    const chosen = await browse("Earlier sessions here", candidates, words, "↑↓ move · type to filter · enter copy the marker · esc quit")
    if (chosen) handOff(chosen.id)
  },
}
