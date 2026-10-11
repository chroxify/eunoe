import { spawnSync } from "node:child_process"
import { askOf, candidatesHere, peekText, shortId, titleOf, tokensOf } from "../sessions"
import { browse, filterCandidates } from "../sessions/browse"
import { UNTITLED } from "../sessions/constants"
import type { SessionCandidate } from "../sessions/types"
import { input, interactive, select } from "../terminal/prompt"
import { ago, c, fail, line, note, wrap } from "../terminal/ui"
import type { Command } from "../types"
import { ASK_INDENT, ASK_MAX_WIDTH, ASK_MIN_WIDTH, PAGER, SESSION_ACTIONS } from "./constants"
import { handOff } from "./continue"
import { loadedLine, writeLoaded } from "./load"

const askWidth = () => Math.max(ASK_MIN_WIDTH, Math.min(ASK_MAX_WIDTH, (process.stdout.columns ?? ASK_MAX_WIDTH + ASK_INDENT) - ASK_INDENT - 12))

function ask(label: string, text: string | undefined) {
  const [first = "", ...rest] = wrap(askOf(text), askWidth())
  line(`${" ".repeat(ASK_INDENT)}${c.dim(label)}  ${first}`)
  for (const more of rest) line(`${" ".repeat(ASK_INDENT + label.length + 2)}${more}`)
}

function show(cand: SessionCandidate) {
  const title = cand.label ? c.bold(cand.label) : c.dim(UNTITLED)
  line(`  ${c.cyan(shortId(cand.id))}  ${title}  ${c.dim(`${cand.asks.length} turns · ~${tokensOf(cand)} tokens · ${ago(new Date(cand.mtime).toISOString())}`)}`)
  ask("first", cand.asks[0])
  ask("last ", cand.asks.at(-1))
  line()
}

export function listSessions(words: string, candidates: SessionCandidate[]) {
  const order = filterCandidates(words, candidates)
  line()
  line(`  ${c.dim(words ? `Earlier sessions here, closest to "${words}" first` : "Earlier sessions here, newest first")}`)
  line()
  for (const cand of order) show(cand)
  if (order.length === 0) line(`  ${c.dim(`Nothing matches "${words}".`)}`)
}

async function act(cand: SessionCandidate): Promise<boolean> {
  const labels: Record<(typeof SESSION_ACTIONS)[number], [string, string]> = {
    continue: ["Continue from it", "copy the prompt for a new chat"],
    peek: ["Peek", "the excerpts that match some words"],
    load: ["Load", "write the whole record to a file"],
    show: ["Show", `read it in ${PAGER}`],
  }
  const action = await select(
    `${shortId(cand.id)}  ${titleOf(cand)}`,
    SESSION_ACTIONS.map((value) => ({ value, label: labels[value][0], hint: labels[value][1] })),
  )
  if (action === "continue") handOff(cand.id)
  else if (action === "load") line(loadedLine(cand, writeLoaded(cand)))
  else if (action === "peek") {
    const words = await input("Look for", "an error, a value, a decision")
    if (!words) return true
    line()
    line(peekText(cand, words) ?? c.dim(`Nothing in ${shortId(cand.id)} matches "${words}".`))
    line()
    return true
  } else if (action === "show") {
    spawnSync(PAGER, [writeLoaded(cand).file], { stdio: "inherit" })
    return true
  }
  return false
}

export const sessions: Command = {
  summary: "Browse earlier sessions in this directory",
  usage: "eunoe sessions [words] [--list]",
  details: [
    "Browse this directory's earlier Claude Code sessions: type to filter, pick",
    "one, then continue from it, peek at it, load it or read it. Words start the",
    "filter. --list, or a pipe, prints them newest first with each one's first",
    "and last request, which is what the agent reads when it runs this itself;",
    "eunoe load <id> then gives it the whole record and eunoe peek <id> <words>",
    "just the excerpts that match.",
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
    let query = words
    while (true) {
      const chosen = await browse("Earlier sessions here", candidates, query)
      if (!chosen) return
      if (!(await act(chosen))) return
      note(c.dim("back to the list"))
      query = ""
    }
  },
}
