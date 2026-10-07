<div align="center">

![eunoe, an axolotl holding a glowing pearl](assets/logo.svg)

# eunoe

**Context management for Claude Code that never forgets what matters.**

A local proxy that replaces Claude Code's context compaction. No summary call,
no two-minute pause, no agent that wakes up having forgotten what you told it.

</div>

> At the top of Dante's Purgatory two rivers run from one spring. **Lethe**
> washes away the memory of what weighed on you. **Eunoe** — *good mind* —
> gives back the memory of the good. You drink from both. Lethe first.

---

## The problem

Fill up a long Claude Code session and it compacts. The agent writes a summary
of everything so far, throws the conversation away, and continues from the
summary.

You can feel it the moment it happens.

```
you    (turn 6)   from now on, deploy to staging yourself, don't ask me
...
you    (turn 41)  ok ship it
agent             Here's the deploy command — want me to run it?
```

The instruction was five turns old and three paragraphs into a 21,000-character
summary. So were the exact version ID from the last deploy, the error you spent
two turns tracking down, and the approach you already ruled out.

Compaction keeps the gist. The gist is not what you need.

It also costs real time. A measured compaction at 922k tokens: **the full
context read for the summary call, 2½ minutes of generation**, then a brand-new
prefix written to cache anyway.

## Install

```sh
bun add -g @chroxify/eunoe   # puts `eunoe` on your PATH
eunoe install                # background proxy + ANTHROPIC_BASE_URL in ~/.claude/settings.json
```

Then use Claude Code exactly as before. New sessions go through eunoe; restart
any that are already running. `eunoe uninstall` reverses it.

Requires [Bun](https://bun.sh). `install` sets up a launchd agent on macOS; on
other platforms, keep `eunoe serve` running however you like (systemd, a
terminal) and the rest works the same.

## What it does instead

Nothing, until the context is nearly full. Every request up to that point goes
upstream byte for byte as Claude Code built it.

At the limit, eunoe rewrites the conversation once. Your first message stays.
Every turn after it collapses to **what you asked and what the agent answered**.
The turn in progress is kept whole, down to the last tool call.

```
WHAT CLAUDE CODE HOLDS (~900k)          WHAT eunoe SENDS
──────────────────────────────          ────────────────────────────────────────
turn 1   first message                  turn 1   first message, byte for byte
         + the agent's work + reply      ┌──────────────────────────────────────┐
turn 2   prompt, 14 tool calls, reply    │ <context-compacted>                  │
turn 3   prompt, 6 tool calls, reply     │ Tool calls before this point were    │
  ⋮                                      │ removed. Earlier turns follow as     │
turn 38  prompt, 9 tool calls ✋          │ your message + the final reply.      │
         (you interrupted mid-work)      │ Instructions you gave still apply.   │
turn 39  prompt, 3 tool calls, reply     │ Exact details → search the           │
turn 40  prompt, 22 tool calls  ← LIMIT  │ transcript: <how>                    │
                                         └──────────────────────────────────────┘
                                        turn 2   your message → final reply
                                        turn 3   your message → final reply
                                          ⋮      every turn, ~580 tokens each
                                        turn 38  your message → [interrupted:
                                                 last words + its tool calls]
                                        turn 39  your message → final reply
                                        turn 40  your message + every tool call
                                                 and result, exactly as it was
                                        turn 41+ grows normally until the next cut
```

**Every turn survives.** A message plus its final reply averages ~580 tokens, so
a hundred turns is ~60k. There is no reason to throw them away. This is what
keeps *"what did we do about the Stripe thing"* and *"you told me to deploy it
yourself"* answerable after a cut.

**The first message is kept verbatim.** Claude Code packs `CLAUDE.md`, your git
status, your identity and the skill list into it. Dropping it drops your
instructions. Its hash also travels in a billing header, so eunoe never edits it.

**The turn in progress is untouched.** The agent is mid-work: it needs the actual
tool calls, their output and its own thinking blocks to carry on. If you
interrupted it, the interruption marker is right there too, so it resumes from
where it stopped rather than starting the turn over.

## How it plugs in

```
 Claude CLI ─┐
 Desktop app ┼──►  eunoe (127.0.0.1:8788)  ──►  api.anthropic.com
 Agent SDK ──┘      rewrites /v1/messages
                    passes everything else straight through
```

Claude Code honours `ANTHROPIC_BASE_URL` from its `settings.json`, so every
harness built on it works with no code changes. Auth headers are forwarded
untouched — your existing login keeps working, subscription or API key.

Claude Code still keeps the whole conversation in memory and on disk at
`~/.claude/projects/<project>/<session>.jsonl`. eunoe only changes what goes out
on the wire. That untouched file is the transcript the agent gets pointed at.

## Modes

| mode | before the limit | at the limit |
|---|---|---|
| **`compact`** (default) | everything, unchanged | the cut, above |
| **`trim`** | every finished turn is already just your message + the final reply | rarely reached |
| **`off`** | passthrough | Claude Code's own compaction |

`trim` is the aggressive option: tool output leaves context the moment a turn
ends, so a long session never grows past a few tens of thousands of tokens. It
is noticeably cheaper and, in benchmarks, no less accurate — but the agent has
to search its transcript more often, so turns start slower.

```sh
eunoe mode compact   # or trim, or off
```

Whichever is on owns compaction: eunoe disables Claude Code's auto-compact while
active and hands it back on `off` or `uninstall`.

## What counts as a final reply

A **turn** starts with a message you sent — text or an image, not a tool result —
and runs until your next one.

Its **final reply** is the last assistant message of that turn, if the turn ended
on text with no tool call in it. Only the text is kept; thinking is dropped.

Across 18,966 real turns:

| how the turn ended | share | what eunoe keeps |
|---|---|---|
| on a text reply | 73% | that reply (median 1.9k chars; 57% name a file path) |
| still running | 17% | nothing — it's the live turn, never reduced |
| interrupted or steered | 10% | last words + the list of tool calls |

Only 1% of finished work turns end in a reply shorter than 120 characters.
Agents already close turns with something usable; eunoe just stops throwing it
away.

In `trim` mode the system prompt tells the agent its final reply is the only
thing it carries forward, and what belongs in it.

## Interruptions and steering

Interrupted turns are where naive summarisation loses the most, so they get
handled explicitly.

| what happened | how eunoe treats it |
|---|---|
| **Esc mid-work**, then a new message | The interrupted turn ends there. Your new message, marker included, opens the next turn. |
| **Typing while the agent works** | Claude Code sends a mid-conversation `system` message. It stays inside the running turn; in a reduced turn it is merged in right before the final reply. |
| **An interrupted turn gets reduced** | No final reply exists, so eunoe writes one: `[This turn was interrupted before a final reply.] Last thing you said: … Tool calls (12): Edit src/app.ts; Bash \`bun test\`; …` |
| **The cut lands on an interrupted turn** | Kept verbatim. The agent sees exactly where it stopped. |
| **Esc-Esc rewind past the cut** | eunoe notices its cut turn is gone from the history and starts over from whatever Claude Code sends. |

## Searching the transcript

Nothing is lost, so the agent is told where everything is and how to look.
`search` picks the form:

| `search` | what the agent gets |
|---|---|
| `jsonl` | Claude Code's raw session file. Complete, but one long JSON-escaped line per entry. |
| **`markdown`** (default) | `index.md` — one line per turn, what was asked and how it ended — plus `turn-0001.md`… with the message, every tool call tagged `[tool 3/12]` with its output, and the final reply. |
| `xml` | The same, as `<turn>` / `<user>` / `<tool n name>` / `<output>` / `<final_reply>`. Easier for the model to parse, slightly harder to grep. |
| `qmd` | The markdown folder indexed by [qmd](https://github.com/tobi/qmd) for semantic search, for when the agent doesn't know the exact words. |

Rendering is fast and idempotent — a 199-turn session takes 0.13s — so it just
runs again as the session grows. qmd's embedding pass takes ~83s and runs in the
background; queries take 3–20s.

## Prompt caching

A compaction scheme that breaks the cache costs more than it saves. Cache writes
are 1.25× the input price and reads are 0.05×, so rewriting a cached prefix is
25× more expensive than reading it.

eunoe's output is deterministic. The same history always produces the same bytes,
a reduced turn always reduces identically, and nothing time-based is ever
inserted. The prefix changes only at a cut.

```
turns 1–39   byte-identical to no proxy at all   → cache hits as usual
turn 40      CUT: one new prefix, written once   → one cache write
turns 41+    same prefix + new turns appended    → reads hit again
```

Measured through the proxy, right after a cut: **180k tokens read from cache,
1.5k written.** Claude Code's own compaction instead reads the entire ~900k
context into a summary call and *then* writes a new prefix.

## Edge cases

The interesting ones are all about what happens when the cut itself doesn't fit.

| case | behaviour |
|---|---|
| **Where a cut lands** | It aims for 30% of the room available — the window minus the fixed system prompt and tool definitions. Land at 70% and you compact again two turns later. |
| **The cut doesn't fit** | Shrink in order, stopping as soon as it fits. **1.** Drop reduced turns, oldest first. **2.** Only then clear the *oldest* tool outputs of the live turn, half of what remains per step, shortening oversized inputs too. |
| **Never removed from the live turn** | Your message, the agent's own text, every tool call, and the **latest 5 tool outputs** — what it is actually working from. |
| **Compaction loops** | Impossible by construction. A cut only ever moves to a newer turn, every shrink step only removes more, and each step is persisted so the bytes stay cache-stable. |
| **Nothing left to remove** | Sends anyway and logs `stuck`. |
| **Context window** | Asked once per model via the Models API (`max_input_tokens`) and cached in `~/.eunoe/models.json`. If the lookup fails the window is unknown and **eunoe does not compact** — it won't cut against a limit it can't verify. |
| **Images and PDFs** | Counted at ~1.6k tokens each, not at their base64 length. |
| **Subagents, titles, side calls** | Each conversation is its own thread (session id + a fingerprint of its first turn) with its own cut. |
| **Mid-conversation system messages** | Never dropped. The API only accepts them directly before an assistant message, so they are merged into that position. |
| **Thinking blocks** | Kept with their signatures in the live turn, where tool use requires them. Dropped from reduced turns. |
| **eunoe is down** | Every Claude request fails. launchd keeps it alive; `uninstall` leaves it running as a passthrough so sessions already pointed at it survive, and `stop` removes it once they're restarted. |

## Early results

A full, pre-registered benchmark is in progress and will be published with its
harness, raw data and every per-point result. Until then, here is what an
earlier internal run showed, with its limits stated.

**Setup.** 45 cut points across 14 projects, from one developer's real Claude
Code history: real auto-compactions, plus long sessions cut where they crossed
350k tokens. At each point, every strategy answered the same 10 questions about
the session — recent details, what was worked on 5–15 turns earlier, standing
instructions, decisions, and what was in progress — through a real Claude Code
session, with read-only access to a transcript that stopped at the cut. Answers
were judged blind.

| strategy | score | context after the cut | vs native, 95% CI |
|---|---|---|---|
| Claude Code's compaction | 84% | 82k | — |
| **eunoe** | **95%** | 183k | **+11.0%** [+8.1, +13.9] |
| eunoe, `trim` mode | 95% | 179k | +11.6% [+8.8, +14.4] |
| eunoe, last 5 turns only | 90% | 164k | +6.4% [+2.4, +10.1] |
| no compaction at all (ceiling) | 97% | 348k | — (7 points) |

eunoe came within two points of never compacting at all, at about half the
context. Claude Code's compaction lost most on what was worked on mid-session
(74%), decisions (77%) and what was in progress (77%).

**What this does not show yet.** The run had no budget-matched baseline — a plain
sliding window given the same token budget — so it can't separate "eunoe keeps
the right things" from "eunoe keeps more". It also used one judge, and many of its
questions were easy enough that every strategy passed them. The full benchmark
adds that baseline, a second judge, harder questions vetted before scoring, and a
task-continuation test, and reports whatever it finds.

## Usage

```sh
eunoe serve              # run in the foreground
eunoe mode compact       # off | trim | compact
eunoe status             # config, plus cache stats for recent requests
eunoe install            # background proxy + Claude Code settings
eunoe uninstall          # new sessions bypass eunoe; proxy stays up as a passthrough
eunoe stop               # remove the background proxy
```

`~/.eunoe/config.json`:

```json
{
  "mode": "compact",
  "compactAt": 0.9,
  "keepTurns": "all",
  "search": "markdown",
  "port": 8788,
  "claudeConfigDirs": []
}
```

Tools that run Claude Code with their own config directory (one per account,
say) need eunoe to know about it, both to find their transcripts and to route
them through the proxy:

```sh
eunoe install --config-dir ~/.my-tool/claude-account-1
```

The directory is remembered in `claudeConfigDirs`.

`compactAt` is a share of the model's real context window. Claude Code compacts
around 93%, so eunoe goes slightly earlier at 90% to win the race.

Every request is logged to `~/.eunoe/requests.jsonl` with what eunoe did to it
and the cache read/write that came back.

## What it doesn't do

- **It is a proxy, so it is a single point of failure.** If it isn't running, and
  `ANTHROPIC_BASE_URL` still points at it, every Claude request fails.
- **It only understands Claude Code's shape** of conversation — first-message
  system reminders, mid-conversation system messages, interruption markers. Other
  Anthropic API clients pass through unchanged but get nothing out of it.
- **It can't recover what Claude Code already compacted.** Turn it on before a
  long session, not after.
- **`trim` mode changes how the agent should write.** It's told to put state in
  its final reply, and it mostly does — but a sloppy final reply costs more in
  `trim` than in `compact`.

## Prior art

Claude Code's own compaction is the thing being replaced, and the summary format
it produces is a reasonable piece of prompt engineering — it just runs after the
conversation is already gone. [qmd](https://github.com/tobi/qmd) does the local
semantic search for the `qmd` mode.

## License

MIT
