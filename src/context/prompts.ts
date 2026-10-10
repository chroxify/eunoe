import type { NoticeCounts } from "./types"

export function compactionNotice(args: NoticeCounts) {
  return [
    "<context-compacted>",
    "Your context was compacted here, so tool calls and their output from before this point were removed.",
    args.omitted > 0
      ? `${args.omitted} of the oldest turns didn't fit and were removed entirely. The ${args.kept} turn${args.kept === 1 ? "" : "s"} after them are shown as the user's message and your final reply.`
      : args.kept > 0
        ? "Every earlier turn is shown below as the user's message and your final reply."
        : "",
    "The turn that was in progress when the context filled up follows in full. Continue from it.",
    "Instructions and preferences the user gave in earlier turns still apply: how they want things done, and what to do or not do on your own. Look back over their messages before you act.",
    "For an exact detail from before this point (an ID, a path, a command, an error, a value, what a tool printed), look it up instead of going from memory. A lookup is cheap; a wrong detail is not. Never say you don't know about something earlier in this session without searching for it first, and if what you remember contradicts what the user says, search before telling them they are wrong.",
    args.guide ?? "",
    "</context-compacted>",
  ].filter(Boolean).join("\n\n")
}

export function truncationNotice(args: NoticeCounts) {
  return [
    "<context-truncated>",
    `${args.omitted} earlier turn${args.omitted === 1 ? " was" : "s were"} dropped to fit the context window. What follows is the most recent ${args.kept} turn${args.kept === 1 ? "" : "s"}, unchanged.`,
    "Instructions and preferences the user gave in earlier turns still apply.",
    args.guide ?? "",
    "</context-truncated>",
  ].filter(Boolean).join("\n\n")
}

export function trimInstructions(guide: string): string {
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
    "It is still your reply to the user, so write it for them, but leave out nothing you will need. State things outright instead of pointing back at tool output: \"as shown above\" means nothing next turn. One exact line (a path, a command, a value) beats a paragraph describing it. A turn that ends on a question still needs the state written down. A trivial turn (a quick answer, small talk) needs no state.",
    "",
    "Instructions and preferences the user gave in earlier turns still apply: how they want things done, and what to do or not do on your own.",
    "",
    "Nothing is lost. What you see of earlier turns is only their outcome. For an exact detail from an earlier turn (an ID, a path, a command you ran, what it printed, a file's earlier content, an error), look it up in the full transcript instead of going from memory or redoing the work. A lookup is cheap; a wrong detail is not.",
    "",
    guide,
    "",
    "What you read from it stays in context for this turn only. If you will need it again later, put it in your final message.",
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

export const CLEARED_OUTPUT = "[Output cleared to keep the context within its limit. It is in the full transcript: search there for this call.]"

export const TRANSCRIPT_FALLBACK = "The full transcript is your Claude Code session file under ~/.claude/projects."

export const SESSIONS_SECTION = [
  "# Earlier sessions in this project",
  "",
  "eunoe keeps the full record of this project's earlier Claude Code sessions, and the user expects you to use it the way a colleague who was there would. When they point you at one, skipping it is the failure to avoid: you will redo finished work, break rules the user already set, and ask for things they already told you.",
  "",
  "## When",
  "",
  "Use these when the user tells you to (`eunoe load <id>` in their message), or when they refer to earlier work you have no context for: a plan, a todo, \"the thing we talked about\", \"where we left off\". `eunoe sessions <key words>` lists the closest earlier sessions, newest first, each with its first and last request; if one clearly continues into this message, load it, otherwise ask which they mean. Do not go looking for work that is clearly new and unrelated.",
  "",
  "## How",
  "",
  "1. `eunoe load <id>` writes that whole session to a file and prints its path. Read the file with the Read tool from the first line to the last, in as many Read calls as its length needs, before you act. Do not grep, head, tail or sed it, and do not stop partway: the rules, values and open todos you need are spread across all of it.",
  "2. Only then start the work. Follow what the record establishes: the user's rules and preferences, decisions made, what was finished and what was left for later. Its values (ids, versions, names, commands) are exact.",
  "",
  "`eunoe peek <id> <words>` returns just the excerpts of a session that match, for a single fact such as an error message or a value. It is not a substitute for loading when the message continues that session's work.",
  "",
  "Don't tell the user you are doing this or ask permission; just do it and carry on with their request.",
].join("\n")
