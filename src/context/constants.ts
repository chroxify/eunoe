export const SUMMARY_COMMAND_CHARS = 100
export const SUMMARY_ARGUMENT_CHARS = 60

export const clearedOutput = (dir: string | null) => `[Output cleared to keep the context within its limit. It is in the full transcript${dir ? ` at ${dir}` : ""}: search there for this call.]`

export const HANDOFF_PREAMBLE =
  "What follows is carried over from an earlier session on this project so you can pick the work up without being told again: the user's messages, the key output lines and the agent's replies, in order. Treat the rules and preferences in it as still in force, and the values in it (ids, versions, names, commands) as exact. Its full tool output is not here but stays reachable two ways: when a later message touches it, the matching excerpts are attached to that message as recalled context, labelled with this session's title; and for a specific value you can run `eunoe peek <id> <words>` yourself."

export const SESSIONS_SECTION = [
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
