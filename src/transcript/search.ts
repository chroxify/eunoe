import { existsSync } from "node:fs"
import path from "node:path"
import type { SearchMode } from "../config/types"
import { QMD_DIR } from "./constants"
import { renderTranscript, transcriptDir } from "./render"
import type { TranscriptRef } from "./types"

const indexing = new Map<string, Promise<void>>()

async function qmd(cwd: string, args: string[]) {
  await Bun.spawn(["qmd", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exited
}

function indexWithQmd(dir: string) {
  const previous = indexing.get(dir) ?? Promise.resolve()
  const next = previous.then(async () => {
    if (!existsSync(path.join(dir, QMD_DIR))) {
      await qmd(dir, ["init"])
      await qmd(dir, ["collection", "add", ".", "--name", "transcript"])
    }
    await qmd(dir, ["update"])
    await qmd(dir, ["embed"])
  }).catch(() => undefined)
  indexing.set(dir, next)
  return next
}

export function prepareTranscript(mode: SearchMode, sessionFile: string, key: string): TranscriptRef {
  const dir = transcriptDir(key)
  if (mode !== "jsonl") {
    try {
      const { changed } = renderTranscript(sessionFile, key, dir, mode === "xml" ? "xml" : "markdown")
      if (mode === "qmd" && (changed || !existsSync(path.join(dir, QMD_DIR)))) void indexWithQmd(dir)
    } catch {}
  }
  return { mode, jsonl: sessionFile, dir }
}

export function searchGuide(ref: TranscriptRef): string {
  if (ref.mode === "jsonl") {
    return [
      `The full transcript is Claude Code's session file: ${ref.jsonl}`,
      "It is JSONL, one entry per line. Your tool calls are `tool_use` blocks in `assistant` entries; their output is in the `tool_result` blocks of the `user` entries that follow. It is large: search it narrowly and never read it whole. For example:",
      `  grep -n 'distinctive text' ${ref.jsonl} | cut -c1-400`,
      `  jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | "\\(.name) \\(.input | tostring | .[0:200])"' ${ref.jsonl}`,
    ].join("\n")
  }
  const ext = ref.mode === "xml" ? "xml" : "md"
  const layout = ref.mode === "xml"
    ? [
        `The full transcript is a folder with one XML file per turn: ${ref.dir}`,
        "- `index.md`: one line per turn, what the user asked and how the turn ended. Skim it to find the turn you need.",
        "- `turn-0001.xml`, …: one turn each, `<turn n>` with `<user>` (the message), `<said>` (what you wrote while working), `<tool n name>` holding `<call>`, `<input>` and `<output>`, and `<final_reply>`.",
      ]
    : [
        `The full transcript is a folder of markdown files: ${ref.dir}`,
        "- `index.md`: one line per turn, what the user asked and how the turn ended. Skim it to find the turn you need.",
        "- `turn-0001.md`, …: one turn each. `## User` (the message), `### [tool 3/12] Bash: …` for every tool call with `[output of tool 3]` below it, and `## Final reply`.",
      ]
  const habits = "Search for more than one phrasing (the exact term, a synonym, a file or function name, an error string) before you conclude something isn't there. Read the whole turn file around a hit: the answer is often a few calls before or after it."
  if (ref.mode === "markdown" || ref.mode === "xml") {
    return [
      ...layout,
      "To find something:",
      `  grep -ril 'distinctive words' ${ref.dir}        # which turns mention it`,
      `  grep -n -i 'distinctive words' ${ref.dir}/*.${ext} | cut -c1-300`,
      `  then Read ${ref.dir}/turn-NNNN.${ext}`,
      habits,
    ].join("\n")
  }
  return [
    ...layout,
    "It is indexed with qmd. Run qmd from inside that folder:",
    `  cd ${ref.dir} && qmd query "a natural-language question"   # semantic + keyword, best when you don't know the exact words (5–20s)`,
    `  cd ${ref.dir} && qmd search "exact words"                 # keyword only, instant`,
    `  then Read ${ref.dir}/turn-NNNN.md (or qmd get turn-NNNN.md)`,
    "If qmd isn't ready yet (the index builds in the background), grep the folder instead.",
    habits,
  ].join("\n")
}
