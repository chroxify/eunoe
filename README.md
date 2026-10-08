<div align="center">

![eunoe, an axolotl holding a glowing pearl](assets/logo.svg)

# eunoe

**Context management for Claude Code that never forgets what matters.**

A local proxy that manages Claude Code's context for it. No summary call, no
two-minute pause, no agent that wakes up having forgotten what you told it.

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

## Results

On 24 held-out sessions with 600 facts planted at known depths (values a
command printed once, errors, instructions given then revised, decisions with
their rejected options), scored by exact match with no judge:

| | recall | instructions applied unprompted | context at the question | tokens per session |
|---|---|---|---|---|
| Claude Code's compaction | 70% | 92% | 70k | 741k |
| no compaction at all (the ceiling) | 100% | 90% | 411k | 815k |
| **eunoe** | **99%** | **95%** | **110k** | **305k** |

**+29 points of recall over Claude Code's compaction** (95% CI +17 to +42),
better on 12 sessions and worse on none, 0% wrong answers. The same +29 margin
holds on 27 cut points taken from real sessions. It matches keeping the whole
history at a quarter of the context.

The method was chosen on a separate development split and frozen before the
test split ran. The suites, the pre-registered specs, every per-arm table and
the honest limits (one developer's repositories, one answering model, one run
per arm) are in [`bench/`](bench/README.md).

## Install

```sh
bun add -g @chroxify/eunoe   # puts `eunoe` (and the short `ee`) on your PATH
eunoe enable                 # starts the background proxy, routes Claude Code through it
```

Then use Claude Code exactly as before. New sessions go through eunoe; restart
any that are already running. `eunoe disable` turns it off again.

Requires [Bun](https://bun.sh). `enable` sets up a launchd agent on macOS; on
other platforms, keep `eunoe serve` running however you like (systemd, a
terminal) and the rest works the same.

## How it works

Three parts, each measured on its own before it was kept.

### Rolling: fold older turns a budget at a time

The last 3 turns are always sent whole, down to the last tool call. Older
turns stay whole too, until the detail in them (tool output, mostly) passes
100k tokens. Then, in one step, every turn before those 3 folds to **what you
asked, the evidence from that turn, and the agent's final reply**.

```
WHAT CLAUDE CODE HOLDS                  WHAT eunoe SENDS AFTER A FOLD
──────────────────────────────          ────────────────────────────────────────
turn 1   first message                  turn 1   first message, byte for byte
         + the agent's work + reply      ┌──────────────────────────────────────┐
turn 2   prompt, 14 tool calls, reply    │ <context-compacted>                  │
turn 3   prompt, 6 tool calls, reply     │ Tool calls before this point were    │
  ⋮                                      │ removed. Earlier turns follow as     │
turn 38  prompt, 9 tool calls ✋          │ your message + evidence + reply.     │
         (you interrupted mid-work)      │ Instructions you gave still apply.   │
turn 39  prompt, 3 tool calls, reply     │ Exact details → search the           │
turn 40  prompt, 22 tool calls           │ transcript: <how>                    │
turn 41  prompt, 5 tool calls            └──────────────────────────────────────┘
turn 42  prompt, 8 tool calls  ← LIVE   turn 2   your message → evidence → reply
                                        turn 3   your message → evidence → reply
                                          ⋮      every turn, ~700 tokens each
                                        turn 38  your message → [interrupted:
                                                 last words + its tool calls]
                                        turn 39  your message → evidence → reply
                                        turn 40  whole
                                        turn 41  whole
                                        turn 42  whole, exactly as it was
```

It is a step, not a slide, and that is what keeps the prompt cache alive. A
cache is a prefix match: change something in the middle and everything after
it is rewritten. Folding one turn per message would rewrite the cache every
turn. Folding 100k at a time writes the folded prefix once, and every request
until the next step reads it at a tenth of the price. The fold pays for itself
within a few requests and frees the window on top.

If the window still fills, a huge live turn say, the full cut kicks in as a
backstop: everything folds, and under pressure the oldest folded turns go
first, then the oldest tool outputs of the live turn.

**Every turn survives.** A message plus evidence plus its final reply averages
~700 tokens, so a hundred turns is ~70k. There is no reason to throw them away.

**The first message is kept verbatim.** Claude Code packs `CLAUDE.md`, your git
status, your identity and the skill list into it. Dropping it drops your
instructions. Its hash also travels in a billing header, so eunoe never edits it.

**The turns in progress are untouched.** The agent is mid-work: it needs the
actual tool calls, their output and its own thinking blocks to carry on. If you
interrupted it, the interruption marker is right there too.

### Evidence: the lines of tool output worth keeping

When a turn folds, each command's output is scanned line by line and scored:
error words and codes, values (ids, hashes, URLs, versions, durations, test and
diff summaries, `key: value` lines), label words like *deployment* or *exit
code*. Every call keeps its best lines, the highest scorers across the turn fill
a 4k-character budget, and they are quoted verbatim under the call that
produced them. The dump goes; the facts stay in the prompt.

Commands whose output can simply be re-run (Read, Grep, Glob, Edit, Write) are
skipped. Across 321 folded turns, patterns kept 97% of the planted values; every
model-based picker tried (Haiku, Jev, two local 3B models) kept fewer.

### Recall: the dropped output a message is about

Once per message you send, before the agent responds, eunoe searches every tool
output no longer in context, plus what the agent said while working, with your
message as the query. Matching excerpts are quoted exactly and appended to your
message, oldest first.

```
you      (turn 71)  deploy is failing with ERR_LEASE_6011 again
eunoe    ─ appends ─  <recalled-context>
                      [turn 12] Bash `bun run deploy:staging`:
                          Deployment ID: dpl_qgthe6u4p7
                          ERR_LEASE_6011: lease expired, retrying with --fresh
                      </recalled-context>
```

Candidates come from BM25, the keyword ranking search engines use, in about
6 ms with no model. Optionally a [Jev](https://typesafe.ai) call reorders the
top 30 in about 300 ms: on the development split that lifted the right excerpt
from 88% to 95% of questions, more than Haiku or Sonnet reranking, cross-encoders
or six embedding models. Without a key, BM25 order is used and nothing else
changes. The recall is computed once per message and pinned to it, so it never
disturbs the cache.

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

| mode | what the model sees |
|---|---|
| **`default`** | the last 3 turns whole; older turns folded a budget at a time; evidence and recall on |
| **`compact`** | everything, unchanged, until the window is nearly full, then one fold with evidence and recall; Claude Code as it is, with only the compaction replaced |
| **`off`** | passthrough; Claude Code compacts on its own |

```sh
eunoe mode compact   # or default, or off
```

Whichever is on owns compaction: eunoe disables Claude Code's auto-compact while
active and hands it back on `off` or `disable`.

## What counts as a final reply

A **turn** starts with a message you sent — text or an image, not a tool result —
and runs until your next one.

Its **final reply** is the last assistant message of that turn, if the turn ended
on text with no tool call in it. Only the text is kept; thinking is dropped.

Across 18,966 real turns:

| how the turn ended | share | what a folded turn keeps |
|---|---|---|
| on a text reply | 73% | that reply (median 1.9k chars; 57% name a file path) |
| still running | 17% | nothing — it's a live turn, never folded |
| interrupted or steered | 10% | last words + the list of tool calls |

Only 1% of finished work turns end in a reply shorter than 120 characters.
Agents already close turns with something usable; eunoe just stops throwing it
away.

## Interruptions and steering

Interrupted turns are where naive summarisation loses the most, so they get
handled explicitly.

| what happened | how eunoe treats it |
|---|---|
| **Esc mid-work**, then a new message | The interrupted turn ends there. Your new message, marker included, opens the next turn. |
| **Typing while the agent works** | Claude Code sends a mid-conversation `system` message. It stays inside the running turn; in a folded turn it is merged in right before the final reply. |
| **A skill loads mid-turn** | Its instructions arrive next to tool output, inside the turn. When that turn folds they're kept, as is anything you typed while it ran, so the agent keeps following the skill. Stale system reminders are dropped. |
| **An interrupted turn gets folded** | No final reply exists, so eunoe writes one: `[This turn was interrupted before a final reply.] Last thing you said: … Tool calls (12): Edit src/app.ts; Bash \`bun test\`; …` |
| **The fold lands on an interrupted turn** | Kept verbatim. The agent sees exactly where it stopped. |
| **Esc-Esc rewind past the fold** | eunoe notices its fold point is gone from the history and starts over from whatever Claude Code sends. |

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
runs again as the session grows. With evidence and recall on, the agent rarely
needs to search: 0.1 lookups per session in the benchmark, against 10 for
Claude Code's compaction.

## Prompt caching

A compaction scheme that breaks the cache costs more than it saves. Cache writes
are 1.25× the input price and reads are 0.1×, so rewriting a cached prefix is
12× more expensive than reading it.

eunoe's output is deterministic. The same history always produces the same bytes,
a folded turn always folds identically, recall is pinned to the message it was
computed for, and nothing time-based is ever inserted. The prefix changes only at
a fold.

```
turns 1–39   byte-identical to no proxy at all   → cache hits as usual
turn 40      FOLD: one new prefix, written once  → one cache write
turns 41–78  same prefix + new turns appended    → reads hit again
turn 79      next fold
```

Measured through the proxy, right after a fold: **180k tokens read from cache,
1.5k written.** Claude Code's own compaction instead reads the entire ~900k
context into a summary call and *then* writes a new prefix.

## Edge cases

The interesting ones are all about what happens when a cut itself doesn't fit.

| case | behaviour |
|---|---|
| **Where a cut lands** | It aims for 30% of the room available — the window minus the fixed system prompt and tool definitions. Land at 70% and you compact again two turns later. |
| **The cut doesn't fit** | Shrink in order, stopping as soon as it fits. **1.** Drop folded turns, oldest first. **2.** Only then clear the *oldest* tool outputs of the live turn, half of what remains per step, shortening oversized inputs too. |
| **Never removed from the live turn** | Your message, the agent's own text, every tool call, and the **latest 5 tool outputs** — what it is actually working from. |
| **Compaction loops** | Impossible by construction. A fold only ever moves to a newer turn, every shrink step only removes more, and each step is persisted so the bytes stay cache-stable. |
| **Nothing left to remove** | Sends anyway and logs `stuck`. |
| **Context window** | Asked once per model via the Models API (`max_input_tokens`) and cached in `~/.eunoe/models.json`. If the lookup fails the window is unknown and **eunoe does not cut** — it won't cut against a limit it can't verify. Budget folds still happen; they depend only on the budget. |
| **Images and PDFs** | Counted at ~1.6k tokens each, not at their base64 length. |
| **Subagents, titles, side calls** | Each conversation is its own thread (session id + a fingerprint of its first turn) with its own fold point. |
| **Mid-conversation system messages** | Never dropped. The API only accepts them directly before an assistant message, so they are merged into that position. |
| **Thinking blocks** | Kept with their signatures in live turns, where tool use requires them. Dropped from folded turns. |
| **Jev unreachable** | Any error or more than 4 seconds and the recall uses BM25 order. The agent never waits on it. |
| **eunoe is down** | Every Claude request fails. launchd keeps it alive; `disable` leaves it running so sessions already pointed at it survive, and `uninstall` removes it once they're restarted. |

## Usage

```sh
eunoe enable             # route Claude Code through eunoe (sets up the proxy the first time)
eunoe enable --session 1baada86   # or manage only the sessions you name
eunoe disable            # new sessions bypass eunoe; running ones keep working
eunoe disable --session 1baada86  # stop managing one session from its next request
eunoe mode compact       # default | compact | off
eunoe mode compact --session 1baada86  # a different mode for one session
eunoe set budget 200000  # any setting, for every session or one (--session <id>)
eunoe status             # what's running, recent sessions, cache stats
eunoe uninstall          # disable and remove the background proxy
eunoe serve              # run the proxy in the foreground (no launchd)
```

Session ids are in Claude Code's `/status`, and `eunoe status` lists the recent
ones it has seen with their working directory. A unique prefix is enough. With
`--session`, every other session still goes through the proxy but untouched, so
you can switch any of them on later without a restart, and Claude Code keeps its
own auto-compact as a backstop for them.

Everything can be set per session with `eunoe set <key> <value> --session <id>`.
Without `--session` it changes the default for every session; `eunoe set` alone
lists the defaults and each session's own values, and `default` as the value
drops a session's own. Changes apply from the session's next request.

| key | default | what it does |
|---|---|---|
| `keep` | `3` | turns kept whole at the end, in `default` mode |
| `budget` | `100000` | tokens of older detail that trigger a fold |
| `compactAt` | `0.9` | share of the context window that triggers the full cut |
| `keepTurns` | `all` | folded turns kept after a full cut |
| `search` | `markdown` | how transcripts are written for the agent to search |
| `rerank` | `jev-preview` | Typesafe model that reorders recall, or `off` |

`~/.eunoe/config.json` holds the same keys, plus `port`, `claudeConfigDirs` and
`sessions`.

Tools that run Claude Code with their own config directory (one per account,
say) need eunoe to know about it, both to find their transcripts and to route
them through the proxy:

```sh
eunoe enable --config-dir ~/.my-tool/claude-account-1
```

The directory is remembered in `claudeConfigDirs`.

`compactAt` is a share of the model's real context window. Claude Code compacts
around 93%, so eunoe goes slightly earlier at 90% to win the race.

### Jev

Recall works without it. To turn the reranker on, put a [Typesafe](https://typesafe.ai)
API key in `~/.eunoe/typesafe-key` or `TYPESAFE_API_KEY`; `eunoe status` shows
whether it is active. `eunoe set rerank off` disables it.

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
- **Recall is keyword search.** Ask about "the deploy that failed" and it finds
  the deploy output; ask about "that thing from before" and it finds nothing,
  and the agent has to search the transcript itself. The reranker narrows this
  but doesn't remove it.

## Prior art

Claude Code's own compaction is the thing being replaced, and the summary format
it produces is a reasonable piece of prompt engineering — it just runs after the
conversation is already gone. [qmd](https://github.com/tobi/qmd) does the local
semantic search for the `qmd` mode. [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
is Typesafe's system-one model, used here as a reranker.

## License

MIT
