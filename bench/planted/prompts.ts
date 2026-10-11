import type { Meta } from "./generate"

export const ANSWER_MODEL = "claude-sonnet-5-5"

export const TASKS = (facts: Meta["facts"]) => `A few quick things before we carry on. Don't run or change anything for these, just answer each one in a sentence or two, as you actually would do it right now.

${facts.map((f) => `${f.id}. ${f.task}`).join("\n")}

Reply with only JSON: {"replies":[{"id":"${facts[0]?.id}","reply":"..."}, ...]}`

export const RECALL = (facts: Meta["facts"]) => `Stop the current work for a moment: this is a memory check about this session. Do not continue the task and do not change anything.

Answer each question about what happened earlier in this session. Use what is in your context. If it isn't there and you know where this session's transcript is, search it (read-only). Do not inspect the project's files or git history to reconstruct answers; they must come from this conversation. If you don't know, answer "unknown" rather than guessing.

Give only the exact value each question asks for (an ID, a number, a name, a flag, a prefix), copied exactly, with no explanation.

${facts.map((f) => `${f.id}. ${f.question}`).join("\n")}

Reply with only JSON: {"answers":[{"id":"${facts[0]?.id}","answer":"..."}, ...]}`
