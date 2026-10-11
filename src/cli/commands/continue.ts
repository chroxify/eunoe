import { readConfig } from "../../config"
import { routedDirs } from "../proxy/inspect"
import { candidatesHere, continuePrompt, copy } from "../sessions"
import { browse } from "../sessions/browse"
import { interactive } from "../terminal/prompt"
import { c, fail, line, ok, warn } from "../terminal/ui"
import type { Command } from "../types"
import { listSessions } from "./sessions"

export function handOff(id: string) {
  const prompt = continuePrompt(id)
  line()
  ok(`${c.bold(prompt)}  ${copy(prompt) ? c.dim("copied") : ""}`)
  if (routedDirs(readConfig()).length === 0) warn("Claude Code isn't routed through eunoe, so the agent won't know to load it (eunoe start).")
  line()
}

export const continueSession: Command = {
  summary: "Pick an earlier session for the agent to continue from",
  usage: "eunoe continue [words] [--list]",
  details: [
    "Pick an earlier session in this directory and get a prompt to paste into any",
    "Claude Code chat, along with what you want done: the CLI, the desktop app,",
    "Kanna. The agent loads that session itself and reads the whole record before",
    "it acts. Words filter the list; keep typing to narrow it.",
    "",
    "eunoe sessions, eunoe peek and eunoe load are the commands the agent uses;",
    "you can run them too.",
  ],
  options: [["--list", "List the sessions without picking one"]],
  async run(args) {
    const words = args
      .filter((a) => !a.startsWith("-"))
      .join(" ")
      .trim()
    const candidates = candidatesHere()
    if (candidates.length === 0) fail("No earlier sessions in this directory to continue from.")
    if (args.includes("--list") || !interactive) return listSessions(words, candidates)
    const chosen = await browse("Continue from", candidates, words, "↑↓ move · type to filter · enter copy the prompt · esc quit")
    if (chosen) handOff(chosen.id)
  },
}
