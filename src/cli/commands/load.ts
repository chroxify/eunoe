import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { paths } from "../../config/constants"
import { foldedView } from "../../context/fold"
import { candidateOf, candidatesHere, shortId, titleOf } from "../sessions"
import { FOLD_CAP_CHARS } from "../sessions/constants"
import type { SessionCandidate } from "../sessions/types"
import { line } from "../terminal/ui"
import type { Command } from "../types"

export function writeLoaded(cand: SessionCandidate): { file: string; lines: number; chars: number } {
  const text = foldedView(cand.messages, FOLD_CAP_CHARS)
  mkdirSync(paths.loaded, { recursive: true })
  const file = path.join(paths.loaded, `${cand.id}.md`)
  writeFileSync(file, text)
  return { file, lines: text.split("\n").length, chars: text.length }
}

export const loadedLine = (cand: SessionCandidate, written: ReturnType<typeof writeLoaded>) =>
  `Session ${shortId(cand.id)} "${titleOf(cand)}" written to ${written.file} (${written.lines} lines, ${Math.round(written.chars / 1000)}k characters). Read the whole file with the Read tool, from line 1 to line ${written.lines}, before acting.`

export const load: Command = {
  summary: "Write an earlier session to a file for the agent to read",
  usage: "eunoe load <id>",
  details: [
    "Writes the whole record of an earlier session in this directory to a file:",
    "your messages, the key output lines and the agent's replies. The agent runs",
    "this when a message continues that session, then reads the file start to",
    "end. Ids come from eunoe sessions; a unique prefix is enough.",
  ],
  run(args) {
    const cand = candidateOf(
      args.find((a) => !a.startsWith("-")),
      candidatesHere(),
    )
    line(loadedLine(cand, writeLoaded(cand)))
  },
}
