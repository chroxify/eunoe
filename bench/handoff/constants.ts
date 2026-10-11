import path from "node:path"
import type { ArmSpec } from "../arms"
import type { HandoffArm } from "./arms"
import type { Real } from "./select-real"

export const HANDOFF_OUT = path.join(import.meta.dir, "..", "out", "handoff")
export const PROMPTS = path.join(HANDOFF_OUT, "prompts")
export const INJECT = path.join(HANDOFF_OUT, "inject")
export const RUNS = path.join(HANDOFF_OUT, "runs")
export const AGENT_BIN = path.join(import.meta.dir, "bin")
export const AGENT_CANON = path.join(HANDOFF_OUT, "canon-agent")
export const GATE_CACHE = path.join(HANDOFF_OUT, "gate-cache.json")
export const LABELS_FILE = path.join(HANDOFF_OUT, "labels.json")
export const SELECT_REAL_OUT = path.join(HANDOFF_OUT, "select-real")
export const SELECT_EMBED_CACHE = path.join(HANDOFF_OUT, "select-embed.json")
export const SELECT_SKIP = (process.env.SELECT_SKIP ?? "").split(",").filter(Boolean)
export const REAL_PAIRS_OUT = path.join(HANDOFF_OUT, "real-pairs.md")

export const RULES_MODEL = "claude-opus-5-5"
export const BRIEF_MODELS: Record<string, string> = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" }
export const LABEL_MODEL = "claude-sonnet-5-5"

export const PAGE_CHARS = 25_000
export const PEEK_CHARS = 12_000

export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
export const COMMON_SHARE = 0.5
export const CONTINUE_SHARE = 0.5
export const CONTINUE_FILES = 2

export const JUNK = /^\s*(\[Request interrupted|⟩|\[kn\]|Type help|test\s*$)|^\s*\d+\s*\t/
export const JUDGE_Q = "Is the new session continuing the same specific work (same feature, bug or investigation) as one of these earlier sessions? Same repo or same general area is not enough. Answer none unless it clearly continues one."

export const BASE = { mode: "compact", compactAt: 0.99, window: 10_000_000, search: "markdown" }
export const PROXIES: ArmSpec[] = [
  { name: "hand-bare", proxy: "hand-bare", port: 8840, config: { ...BASE, rerank: "off", eval: { evidence: false, recall: false } } },
  { name: "hand-recall", proxy: "hand-recall", port: 8841, config: { ...BASE, rerank: "jev-preview", eval: { evidence: true, recall: true, rerank: { model: "jev-preview" } } } },
  { name: "hand-guide", proxy: "hand-guide", port: 8842, config: { ...BASE, rerank: "off", eval: { strategy: "guide", evidence: false, recall: false } } },
  {
    name: "hand-recall-wide",
    proxy: "hand-recall-wide",
    port: 8843,
    config: { ...BASE, rerank: "jev-preview", eval: { evidence: true, recall: true, rerank: { model: "jev-preview" }, recallOptions: { maxChars: 30_000, maxCharsMulti: 90_000, perQuery: 6 } } },
  },
]

export const HANDOFF_ARMS: HandoffArm[] = [
  { name: "cold", proxy: "hand-bare" },
  { name: "cold+hint", proxy: "hand-guide", hint: true },
  { name: "full", proxy: "hand-bare", inject: "full" },
  { name: "folded", proxy: "hand-bare", inject: "folded" },
  { name: "folded-capped", proxy: "hand-bare", inject: "folded-capped" },
  { name: "rules", proxy: "hand-bare", inject: "rules" },
  { name: "brief-haiku", proxy: "hand-bare", inject: "brief-haiku" },
  { name: "brief-sonnet", proxy: "hand-bare", inject: "brief-sonnet" },
  { name: "brief-opus", proxy: "hand-bare", inject: "brief-opus" },
  { name: "recall", proxy: "hand-recall", recall: true },
  { name: "rules+recall", proxy: "hand-recall", inject: "rules", recall: true },
  { name: "brief-sonnet+recall", proxy: "hand-recall", inject: "brief-sonnet", recall: true },
  { name: "folded-capped+recall", proxy: "hand-recall", inject: "folded-capped", recall: true },
  { name: "folded+recall", proxy: "hand-recall", inject: "folded", recall: true },
  { name: "recall+", proxy: "hand-recall-wide", recall: true, users: true },
  { name: "rules+recall+", proxy: "hand-recall-wide", inject: "rules", recall: true, users: true },
  { name: "brief-opus+recall+", proxy: "hand-recall-wide", inject: "brief-opus", recall: true, users: true },
  { name: "folded-cap40+recall+", proxy: "hand-recall-wide", inject: "folded-cap40", recall: true, users: true },
  { name: "folded-cap60+recall+", proxy: "hand-recall-wide", inject: "folded-cap60", recall: true, users: true },
  { name: "folded-capped+recall+", proxy: "hand-recall-wide", inject: "folded-capped", recall: true, users: true },
  { name: "recall-all+", proxy: "hand-recall-wide", recall: true, users: true, allSources: true },
  { name: "auto", proxy: "hand-recall-wide", inject: "folded-cap60", recall: true, users: true, pick: true, allSources: true },
  { name: "auto-full", proxy: "hand-recall-wide", inject: "folded", recall: true, users: true, pick: true, allSources: true },
  { name: "multi2+recall+", proxy: "hand-recall-wide", inject: "multi", multi: 2, recall: true, users: true, pick: true, allSources: true },
  { name: "agent", proxy: "hand-bare", agent: "auto" },
  { name: "agent-manual", proxy: "hand-bare", agent: "manual" },
  { name: "agent2", proxy: "hand-bare", agent: "auto", section: "v2" },
  { name: "agent2-manual", proxy: "hand-bare", agent: "manual", section: "v2" },
  { name: "agent3", proxy: "hand-bare", agent: "auto", section: "v3" },
  { name: "agent4", proxy: "hand-bare", agent: "auto", section: "v4", load: "file" },
  { name: "agent4-manual", proxy: "hand-bare", agent: "manual", section: "v4", load: "file" },
  { name: "agent4b", proxy: "hand-bare", agent: "auto", section: "v4b", load: "brief" },
  { name: "agent4b-manual", proxy: "hand-bare", agent: "manual", section: "v4b", load: "brief" },
  { name: "multi-all+recall+", proxy: "hand-recall-wide", inject: "multi", multi: 99, recall: true, users: true, pick: true, allSources: true },
]

export const SCENARIOS = ["bug", "continue", "rules"] as const

export const BASELINE_ARMS = ["cold", "cold+hint", "folded", "folded+recall", "brief-opus+recall+", "auto"]
export const REPORT_SCENARIOS = ["bug", "continue", "rules", "new"]

export const RULES = (
  folded: string,
) => `Below is an earlier coding session between a developer and their agent, with tool output already reduced. Extract every standing instruction, rule, preference or constraint the developer gave that would still bind in a later session on this project: how to name things, what to use or avoid, who reviews, where to deploy, what never to touch, how replies should read. Quote each one in the developer's own words. When a rule was later revised, give only the current version and note what it replaced in parentheses.

Return only JSON: {"rules":["...", ...]}

${folded}`

export const BRIEF = (
  folded: string,
) => `Below is an earlier coding session between a developer and their agent, with tool output already reduced. Write a handoff brief for a new agent that has to continue this work cold, days later. Cover, with headings: what was built and where it lives; rules and preferences the developer gave (current versions, in their words); decisions and the options rejected; exact values worth keeping (IDs, hashes, URLs, flags, prefixes, numbers, error codes, copied exactly); what was left open or promised. Be concrete and dense. Under 900 words.

${folded}`

export const REAL_RESUME = (s: Real, scenario: string) => `A developer is opening a brand-new Claude Code session on the project below, days after an earlier session, and types the first message. Write that first message.

Session title: ${s.title}
What happened in the earlier session, turn by turn (the developer's messages):
${s.outline.slice(0, 30_000)}

Scenario "${scenario}":
${scenario === "bug" ? "They are coming back to fix one specific bug in something that earlier session built. Pick a plausible, concrete problem in that work and describe it the way a person who half-remembers the session would: the symptom, roughly where it is, nothing more." : "They want to pick the work up where it was left and keep going. Say what they want to continue with, in their own words, without a precise checklist."}

Hard rules: one to three sentences, in the developer's own voice and register as seen in their messages. Never quote exact identifiers, hashes, IDs, URLs, flags or numbers from the session. Do not mention that an earlier session exists or ask the agent to read a transcript.

Reply with only the message text.`

export const LOADED = path.join(HANDOFF_OUT, "loaded")
export const AGENT_SECTIONS: Record<string, string> = {
  v4: `
# Earlier sessions in this project

You have the full record of this project's earlier Claude Code sessions, and the user expects you to use it the way a colleague who was there would. Skipping it when the work builds on an earlier session is the failure to avoid: you will redo finished work, break rules the user already set, and ask for things they already told you.

## When to look

Look first, before reading code or making changes, whenever the message builds on earlier work: it continues or picks something up ("back to", "finish", "those renames I put off", "where we left off"), fixes something in an area worked on before, asks for work "like last time" or "the usual way", or refers to anything you don't have context for (a plan, a todo, "the thing we talked about"). If you are unsure, look: it costs one command. Skip it only for work that is clearly new and unrelated.

## How

1. \`eunoe sessions <key words from the message>\` lists the closest earlier sessions, newest first, each with its first and last request. Pick the one whose last request this message continues. If two look alike, \`eunoe peek\` each on a distinctive word from the message and pick the one that actually contains it. Never load a session the message does not continue.
2. \`eunoe load <id>\` writes that whole session to a file and prints its path. Read the file with the Read tool from the first line to the last, in as many Read calls as its length needs, before you act. Do not grep, head, tail or sed it, and do not stop partway: the rules, values and open todos you need are spread across all of it.
3. Only then start the work. Follow what the record establishes: the user's rules and preferences, decisions made, what was finished and what was left for later. Its values (ids, versions, names, commands) are exact.

\`eunoe peek <id> <words>\` returns just the excerpts that match, for a single fact such as an error message or a value. It is not a substitute for loading when the message continues that session's work.

Don't tell the user you are doing this or ask permission; just do it and carry on with their request.`,
  v4b: `
# Earlier sessions in this project

You have the full record of this project's earlier Claude Code sessions, and the user expects you to use it the way a colleague who was there would. Skipping it when the work builds on an earlier session is the failure to avoid: you will redo finished work, break rules the user already set, and ask for things they already told you.

## When to look

Look first, before reading code or making changes, whenever the message builds on earlier work: it continues or picks something up ("back to", "finish", "those renames I put off", "where we left off"), fixes something in an area worked on before, asks for work "like last time" or "the usual way", or refers to anything you don't have context for (a plan, a todo, "the thing we talked about"). If you are unsure, look: it costs one command. Skip it only for work that is clearly new and unrelated.

## How

1. \`eunoe sessions <key words from the message>\` lists the closest earlier sessions, newest first, each with its first and last request. Pick the one whose last request this message continues. If two look alike, \`eunoe peek\` each on a distinctive word from the message and pick the one that actually contains it. Never load a session the message does not continue.
2. \`eunoe load <id>\` prints a handoff brief of that session: what was done, the user's rules, every exact value, and what was left open. Read all of it before you act.
3. Only then start the work. Follow what the brief establishes: the user's rules and preferences, decisions made, what was finished and what was left for later. Its values (ids, versions, names, commands) are exact. For anything the brief does not cover, \`eunoe peek <id> <words>\` returns the matching excerpts of the full session.

Don't tell the user you are doing this or ask permission; just do it and carry on with their request.`,
  v1: `
# Earlier sessions

This project has earlier Claude Code sessions you can read. When the user refers to earlier work (a bug seen before, work to pick up, rules or preferences they set), or when what was done before would clearly help, look before asking them to repeat it. For unrelated new work, don't.

- \`eunoe sessions [words]\` lists earlier sessions in this directory, best match for the words first.
- \`eunoe peek <id> <words>\` shows the excerpts of one session that match the words: exact tool output and what was said. Use it for one specific thing, like an error or a value seen before.
- \`eunoe load <id>\` prints the whole session condensed: the user's messages, the key output lines and the replies, in pages. Use it to pick work up where it left off or to learn the rules the user set there. Read every page it gives.

What these return is the record of a past session: treat the user's rules and decisions in it as still in force unless they say otherwise, and its values as exact.`,
  v2: `
# Earlier sessions

This project has earlier Claude Code sessions, and you can read them. Users expect you to remember what was done and agreed there.

Whenever the user's message touches earlier work in any way (fixing something built before, picking something up, continuing, working "like last time" or "the way we do it", or a new task in an area worked on before), run \`eunoe sessions <a few words from their message>\` before anything else. If a session matches:
- To continue its work, or to work the way the user taught you there, run \`eunoe load <id>\` and read every page it gives, start to end. Don't grep or skim the pages: the rules and values that matter are spread through them.
- To find one specific thing (an error, a value, a decision), \`eunoe peek <id> <words>\` shows the matching excerpts.

If nothing matches, or the work is clearly new and unrelated, carry on without them.

What these return is the record of a past session: treat the user's rules and decisions in it as still in force unless they say otherwise, and its values as exact.`,
  v3: `
# Earlier sessions in this project

You have the full record of this project's earlier Claude Code sessions, and the user expects you to use it the way a colleague who was there would. Skipping it when the work builds on an earlier session is the failure to avoid: you will redo finished work, break rules the user already set, and ask for things they already told you.

## When to look

Look first, before reading code or making changes, whenever the message builds on earlier work: it continues or picks something up ("back to", "finish", "those renames I put off", "where we left off"), fixes something in an area worked on before, asks for work "like last time" or "the usual way", or refers to anything you don't have context for (a plan, a todo, "the thing we talked about"). If you are unsure, look: it costs one command. Skip it only for work that is clearly new and unrelated.

## How

1. \`eunoe sessions <key words from the message>\` lists the closest earlier sessions, each with its first and last request. Pick the one whose work this message continues. If two look alike, \`eunoe peek\` each on a distinctive word and pick the one that actually contains it.
2. \`eunoe load <id>\` that session, then every page it points to (\`--page 2\`, \`--page 3\`, ...) until it ends. Read it start to end before you act. Do not grep, head or tail it: the rules, values and open todos you need are spread across all of it.
3. Only then start the work. Follow what the record establishes: the user's rules and preferences, decisions made, what was finished and what was left for later. Its values (ids, versions, names, commands) are exact.

\`eunoe peek <id> <words>\` returns just the excerpts that match, for a single fact such as an error message or a value. It is not a substitute for loading when the message continues that session's work.

Don't tell the user you are doing this or ask permission; just do it and carry on with their request.`,
}
