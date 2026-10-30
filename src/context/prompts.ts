import type { TranscriptRef } from "../transcript/search"
import { truncate } from "./content"

interface NoticeCounts {
  omitted: number
  kept: number
  pinned?: number
  guide: string | null
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

export const SYSTEM_PROMPT = [
  "# Earlier sessions in this project",
  "",
  "eunoe keeps the full record of this project's earlier Claude Code sessions, and the user expects you to use it the way a colleague who was there would. When they point you at one, skipping it is the failure to avoid: you will redo finished work, break rules the user already set, and ask for things they already told you.",
  "",
  "## When",
  "",
  'A message carrying `{ee:continue:<id>}` already has that session attached to it as a `<handoff>` block: read it as part of the message, nothing to run. Use the commands below when the user names a session without the marker (`eunoe load <id>`), or when they refer to earlier work you have no context for: a plan, a todo, "the thing we talked about", "where we left off". `eunoe sessions <key words>` lists the closest earlier sessions, newest first, each with its first and last request; if one clearly continues into this message, load it, otherwise ask which they mean. Do not go looking for work that is clearly new and unrelated.',
  "",
  "## How",
  "",
  "1. `eunoe load <id>` writes that whole session to a file and prints its path. Read the file with the Read tool from the first line to the last, in as many Read calls as its length needs, before you act. Do not grep, head, tail or sed it, and do not stop partway: the rules, values and open todos you need are spread across all of it.",
  "2. Only then start the work. Follow what the record establishes: the user's rules and preferences, decisions made, what was finished and what was left for later. Its values (ids, versions, names, commands) are exact.",
  "",
  "`eunoe peek <id> <words>` returns just the excerpts of a session that match, for a single fact such as an error message or a value. It is not a substitute for loading when the message continues that session's work.",
  "",
  "Loading or peeking needs no permission and no announcement: run it and carry on with the request.",
].join("\n")

const HANDOFF_PREAMBLE =
  "What follows is carried over from an earlier session on this project so you can pick the work up without being told again: the user's messages, the key output lines and the agent's replies, in order. Treat the rules and preferences in it as still in force, and the values in it (ids, versions, names, commands) as exact. Its full tool output is not here but stays reachable two ways: when a later message touches it, the matching excerpts are attached to that message as recalled context, labelled with this session's title; and for a specific value you can run `eunoe peek <id> <words>` yourself."

export function handoffBlock(label: string, text: string): string {
  return `<handoff from="${label}">\n${HANDOFF_PREAMBLE}\n\n${text}\n</handoff>`
}

export function recalledContext(entries: string[], fromEarlierSessions: boolean): string {
  const where = fromEarlierSessions ? "earlier in this session or in an earlier session on this project" : "earlier in this session"
  return `<recalled-context>\nExcerpts from ${where} that match this message: tool output that is no longer in your context, quoted exactly, oldest first. Where the same thing appears twice, the later turn is current. Use them if they answer what was asked; ignore them otherwise.\n\n${entries.join("\n")}\n</recalled-context>`
}

export function rerankQuestion(query: string): string {
  return `Which excerpt contains the exact answer to the developer's question about this coding session: "${query}"?`
}

export function toolEvidence(entries: string[]): string {
  return `<tool-evidence>\nKey lines of command output from this turn, kept verbatim (the full output is in the transcript):\n${entries.join("\n")}\n</tool-evidence>`
}

export function interruptedReply(lastWords: string | undefined, calls: string[]): string {
  const shown = calls.slice(-20)
  return [
    "[This turn was interrupted before a final reply.]",
    lastWords ? `Last thing you said: ${lastWords.length > 600 ? `${truncate(lastWords, 600)}…` : lastWords}` : "",
    calls.length > 0 ? `Tool calls (${calls.length}${calls.length > shown.length ? `, last ${shown.length} shown` : ""}): ${shown.join("; ")}` : "",
    "Their output is in the full transcript.",
  ]
    .filter(Boolean)
    .join("\n")
}

export function clearedOutput(dir: string | null): string {
  return `[Output cleared to keep the context within its limit. It is in the full transcript${dir ? ` at ${dir}` : ""}: search there for this call.]`
}

export function clearedInput(kept: string, cleared: number): string {
  return `${kept}… [${cleared} chars cleared; in the transcript]`
}

export function compactionNotice({ omitted, kept, pinned = 0, guide }: NoticeCounts): string {
  return [
    "<context-compacted>",
    "Your context was compacted here, so tool calls and their output from before this point were removed.",
    omitted > 0
      ? `${omitted} of the oldest turns didn't fit and were removed entirely. The ${plural(kept, "turn")} after them are shown as the user's message and your final reply.`
      : kept > 0
        ? "Every earlier turn is shown below as the user's message and your final reply."
        : "",
    pinned > 0 ? `${pinned === 1 ? "One earlier turn was" : `${pinned} earlier turns were`} kept whole, with their tool calls and output, because they matter to what comes next.` : "",
    "The turn that was in progress when the context filled up follows in full. Continue from it.",
    "Instructions and preferences the user gave in earlier turns still apply: how they want things done, and what to do or not do on your own. Look back over their messages before you act.",
    "For an exact detail from before this point (an ID, a path, a command, an error, a value, what a tool printed), look it up instead of going from memory. A lookup is cheap; a wrong detail is not. Never say you don't know about something earlier in this session without searching for it first, and if what you remember contradicts what the user says, search before telling them they are wrong.",
    guide ?? "",
    "</context-compacted>",
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function truncationNotice({ omitted, kept, guide }: NoticeCounts): string {
  return [
    "<context-truncated>",
    `${omitted} earlier turn${omitted === 1 ? " was" : "s were"} dropped to fit the context window. What follows is the most recent ${plural(kept, "turn")}, unchanged.`,
    "Instructions and preferences the user gave in earlier turns still apply.",
    guide ?? "",
    "</context-truncated>",
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function trimInstructions(guide: string | null): string {
  return [
    "# Context between turns",
    "",
    "This session trims its context between turns: of every earlier turn you keep only the user's message (with anything that arrived with it) and your final message. Everything in between is gone when the next turn starts: tool calls and their results, files you read, command output, your thinking, and anything you wrote along the way. Within a turn, nothing is trimmed.",
    "",
    "So your final message is the only memory you carry forward. End each turn with a final message that lets you pick the work back up cold:",
    "- What changed: files with their paths, branches, commits, PRs, anything created, moved or deleted.",
    "- What you found: facts you would otherwise have to dig up again. Where code lives, how something works, the cause of a bug, exact error text, IDs, URLs, the numbers that matter.",
    "- Decisions and their reasons, including approaches you tried and ruled out.",
    "- Where things stand: what is done, what is not, what you verified and how, and what is waiting on the user.",
    "",
    'It is still your reply to the user, so write it for them, but leave out nothing you will need. State things outright instead of pointing back at tool output: "as shown above" means nothing next turn. One exact line (a path, a command, a value) beats a paragraph describing it. A turn that ends on a question still needs the state written down. A trivial turn (a quick answer, small talk) needs no state.',
    "",
    "Instructions and preferences the user gave in earlier turns still apply: how they want things done, and what to do or not do on your own.",
    ...(guide
      ? [
          "",
          "Nothing is lost. What you see of earlier turns is only their outcome. For an exact detail from an earlier turn (an ID, a path, a command you ran, what it printed, a file's earlier content, an error), look it up in the full transcript instead of going from memory or redoing the work. A lookup is cheap; a wrong detail is not.",
          "",
          guide,
          "",
          "What you read from it stays in context for this turn only. If you will need it again later, put it in your final message.",
        ]
      : []),
  ].join("\n")
}

export function searchOnlyInstructions(guide: string): string {
  return [
    "# The full transcript",
    "",
    "Earlier parts of this session may be summarised or missing from your context. The complete record is on disk, and for any exact detail from earlier (an ID, a path, a command you ran, what it printed, an error, a value) you should look it up there rather than answer from memory. A lookup is cheap; a wrong detail is not. Never say you don't know about something earlier in this session without searching for it first.",
    "",
    guide,
  ].join("\n")
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
  const layout =
    ref.mode === "xml"
      ? [
          `The full transcript is a folder with one XML file per turn: ${ref.dir}`,
          "- `index.md`: one line per turn, what the user asked and how the turn ended. Skim it to find the turn you need.",
          "- `turn-0001.xml`, …: one turn each, `<turn n>` with `<user>` (the message), `<said>` (what you wrote while working), `<tool n name>` holding `<call>`, `<input>` and `<output>`, and `<final_reply>`.",
          "- `turn-0001-subagent-1.xml`, …: the whole run of a subagent launched in that turn, same layout. The turn itself only has the subagent's report; what the subagent saw and ran is here.",
        ]
      : [
          `The full transcript is a folder of markdown files: ${ref.dir}`,
          "- `index.md`: one line per turn, what the user asked and how the turn ended. Skim it to find the turn you need.",
          "- `turn-0001.md`, …: one turn each. `## User` (the message), `### [tool 3/12] Bash: …` for every tool call with `[output of tool 3]` below it, and `## Final reply`.",
          "- `turn-0001-subagent-1.md`, …: the whole run of a subagent launched in that turn, same layout. The turn itself only has the subagent's report; what the subagent saw and ran is here.",
        ]
  const habits =
    "Search for more than one phrasing (the exact term, a synonym, a file or function name, an error string) before you conclude something isn't there. Read the whole turn file around a hit: the answer is often a few calls before or after it."
  if (ref.mode === "qmd") {
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
  const ext = ref.mode === "xml" ? "xml" : "md"
  return [
    ...layout,
    "To find something:",
    `  grep -ril 'distinctive words' ${ref.dir}        # which turns mention it`,
    `  grep -n -i 'distinctive words' ${ref.dir}/*.${ext} | cut -c1-300`,
    `  then Read ${ref.dir}/turn-NNNN.${ext}`,
    habits,
  ].join("\n")
}
