import { candidateOf, candidatesHere, peekText, shortId } from "../sessions"
import type { Command } from "../types"
import { fail, line } from "../ui"

export const peek: Command = {
  summary: "Show the excerpts of an earlier session that match some words",
  usage: "eunoe peek <id> <words>",
  details: [
    "Searches one earlier session in this directory for the words and prints the",
    "excerpts that match: tool output and your messages, quoted exactly. For a",
    "single fact such as an error message or a value. To continue the session's",
    "work the agent should eunoe load it instead. Ids come from eunoe sessions.",
  ],
  run(args) {
    const [id, ...rest] = args.filter((a) => !a.startsWith("-"))
    const cand = candidateOf(id, candidatesHere())
    const words = rest.join(" ").trim()
    if (!words) fail("Say what to look for: eunoe peek <id> <words>")
    line(peekText(cand, words) ?? fail(`Nothing in ${shortId(cand.id)} matches "${words}".`))
  },
}
