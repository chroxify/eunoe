<div align="center">

![eunoe, an axolotl holding a glowing pearl](assets/logo.svg)

# eunoe

**Context management for Claude Code that never forgets what matters.**

A local proxy that keeps long Claude Code sessions sharp. Smaller context,
nothing lost, no pause, no restart.

</div>

---

## The problem

Every long Claude Code session eventually turns dumb on you, and it happens
well before the context window is full. The agent starts forgetting rules you
gave it an hour ago, re-reading files it already read, and asking about
decisions you made together. When compaction finally kicks in it makes things
worse, because the whole conversation gets replaced by a summary and anything
the summary left out is gone for good.

At that point the only fix is a fresh session, which means explaining the
project again, pasting the rules again, and hoping it gets further this time.

The reason is that every file the agent ever opened and every command it ever
ran stays in the prompt, so two hundred turns in the model is still reading a
log from the first hour on every request, with the thing you said five turns
ago buried somewhere in the middle of it.

| | Claude Code | eunoe |
|---|---|---|
| **context** | grows with every tool call until it fills the window | finished turns fold to your message, the output lines that mattered and the reply; turns in progress go out whole |
| **at the limit** | a two-minute summary call replaces the whole conversation | never reached |
| **old details** | gone unless the summary kept them | come back the moment a message is about them |
| **your instructions** | survive if the summary mentions them | kept word for word |
| **the session** | one window, then you start over | as sharp at turn three hundred as at turn three |

## Results

Measured on 24 held-out sessions of 90 to 120 turns with 600 facts planted
at known depths, such as a value a command printed once, an error, an
instruction that was later revised or a decision with its rejected options,
and scored by exact match with no judge involved.

> These numbers come from one developer's sessions. They are a careful
> measurement, not a general one, so read them as a strong signal rather than
> a guarantee for your own work.

| | facts remembered | rules followed without a reminder | prompt size when asked | tokens per session | transcript lookups per session | time per session | said "I don't know" | answered wrong |
|---|---|---|---|---|---|---|---|---|
| Claude Code's compaction | 70% | 92% | 70k | 741k | 10.1 | 53s | 172 of 600 | 7 of 600 |
| Claude Code, told a transcript exists | 99% | 92% | 71k | 1,315k | 23.0 | 88s | 3 of 600 | 6 of 600 |
| keeping the whole history | 100% | 90% | 411k | 815k | 0 | 67s | 0 of 600 | 3 of 600 |
| eunoe, folding only | 99% | 92% | 118k | 490k | 2.7 | 40s | 4 of 600 | 5 of 600 |
| **eunoe** | **99%** | **95%** | **110k** | **305k** | **0.1** | **39s** | **1 of 600** | **3 of 600** |

*Facts remembered* is how many of the planted facts the agent could still
answer correctly after the cut. *Rules followed without a reminder* is how
often it applied an instruction from earlier in the session when the task
called for it, without being told again. *Prompt size* is the context the
model was reading when the question came, while *tokens per session* adds up
every request it took to get through the questions, so it grows whenever the
agent has to go and look something up.

That is **29 points more recall than Claude Code's compaction** (95% CI +17
to +42), better on 12 sessions and worse on none, with 3 wrong answers out
of 600, and the same margin holds on 27 cut points taken from real sessions.
eunoe matches keeping the whole history at a quarter of the context and 40%
of the tokens.

The surprising part is not that eunoe remembers more, it is how. Telling
Claude Code that a transcript exists gets it to 99% too, but it has to grep
for the answer 23 times a session to do it, which is why it burns four times
the tokens. eunoe reaches the same 99% with about one lookup every ten
sessions, because the answer is already in the prompt when the question
arrives, and it is faster than keeping the whole history even though that
arm never searches at all. The two eunoe rows differ only in whether the
exact lines of old output are kept and brought back, which is the part of
the design explained below.

The method was chosen on a separate development split and frozen before the
test split ran. The suites, the pre-registered spec, every per-arm table and
the limits of the study (one developer's repositories, one answering model,
one run per arm) are in [`bench/`](bench/README.md).

Context management is hard to benchmark well alone, because the honest test
is many people's real sessions. If you run the bench on your own sessions,
find a case where eunoe does worse, or have a better way to measure this,
please open an issue or a pull request. Results from other setups are the
contribution I'd value most.

## Install

```sh
bun add -g @chroxify/eunoe   # puts `eunoe` and the short `ee` on your PATH
eunoe start                  # sets up the background proxy, routes Claude Code through it
```

Then use Claude Code exactly as before. New sessions go through eunoe, and
sessions that were already running pick it up when you restart them.
`eunoe stop` turns it off again.

Requires [Bun](https://bun.sh). On macOS `start` sets up a launchd agent that
keeps the proxy alive and a watchdog that unroutes Claude Code if the proxy
should ever be down; on other platforms keep `eunoe serve` running however you like and
everything else works the same. The proxy listens on 127.0.0.1:38663 (`port`
in `~/.eunoe/config.json` changes it).

## How it works

eunoe does three things, and each one was measured on its own before it was
kept.

### Folding

A **turn** is one message from you and everything the agent did until your
next one. Once a turn is finished, most of what it holds is tool output the
agent needed in the moment and will never read again.

A finished turn, as Claude Code keeps it (about 9,000 tokens):

```
[you]     fix the failing lease test

[agent]   I'll look at the test first.
  [tool]  Read src/lease.test.ts
            ... 140 lines of file ...
  [tool]  Bash bun test
            ... 80 lines of output ...

[agent]   The expiry check is off by one.
  [tool]  Edit src/lease.ts
  [tool]  Bash bun test
            ... 80 lines of output ...

[agent]   Fixed the off-by-one in renew(): the expiry check used <= instead
          of <. All 4 tests pass. The 6011 code comes from LEASE_EXPIRED in
          src/errors.ts.
```

The same turn after eunoe folds it (about 700 tokens):

```
[you]       fix the failing lease test

[evidence]  Bash bun test
              FAIL  lease renews after expiry
              expected 6011, got undefined
              3 pass, 1 fail

[agent]     Fixed the off-by-one in renew(): the expiry check used <= instead
            of <. All 4 tests pass. The 6011 code comes from LEASE_EXPIRED in
            src/errors.ts.
```

The agent already writes a usable summary of every turn in its final reply,
so folding keeps that reply, your message and the evidence described below,
and drops everything else. A hundred folded turns come to about 70k tokens,
which is why eunoe never has to throw a turn away.

The timing is what makes this cheap. The last 3 turns are always sent whole,
down to the last tool call, and older turns stay whole too until the detail
in them passes a budget of 100k tokens. At that point every turn except
those 3 folds in one step.

```
turn   1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24
       -----------------------------------------------------------------------
 t=10  W  W  W  W  W  W  W  W  W  L                           budget not reached
 t=20  W  W  W  W  W  W  W  W  W  W  W  W  W  W  W  W  W  W  W  L
 t=21  F  F  F  F  F  F  F  F  F  F  F  F  F  F  F  F  F  F  W  W  L   <- fold
 t=24  F  F  F  F  F  F  F  F  F  F  F  F  F  F  F  F  F  F  W  W  W  W  W  L

       W whole   F folded   L the live turn
```

It happens in a step rather than a slide because of the prompt cache. The
cache is a prefix match, so changing anything in the middle rewrites
everything after it at 1.25 times the price of a read. Folding one turn per
message would rewrite the cache on every message, whereas folding a budget
at a time writes the new prefix once and lets every request until the next
step read it at a tenth of the price.

The first message is always kept verbatim, because Claude Code packs
`CLAUDE.md`, your git status and your skills into it and its hash travels in
a billing header. The live turns are untouched too, thinking blocks and
interruptions included. If a turn was interrupted before the agent replied,
the fold keeps its last words and the list of what it ran instead.

### Evidence

Folding on its own would lose the exact values in tool output, like the
deployment id, the error code or the test count, so when a turn folds each
command's output is scored line by line and the lines worth keeping are
quoted verbatim under the command that produced them.

```
score   line
-----   ------------------------------------------------------------
  +3    FAIL  lease renews after expiry           error words and codes
  +3    Deployment ID: dpl_qgthe6u4p7              ids, hashes, URLs
  +2    3 pass, 1 fail                             test and diff summaries
  +2    ERR_LEASE_6011: lease expired              error codes
  +2    took 412 ms                                durations, sizes, versions
  +1    status: applied                            key: value
   0    Compiling 14 modules...                    dropped
   0    > lease@1.4.0 test                         dropped
```

Every command keeps its best lines, and the highest scorers across the turn
fill a budget of about 4,000 characters, which is a few hundred tokens. The
cap exists because a long test or build log would otherwise fold to
something bigger than the turn it came from, and the size was chosen on the
development split, where it kept 97% of the planted values. Commands whose
output can simply be run again, such as `Read`, `Grep`, `Glob`, `Edit` and
`Write`, are skipped entirely.

### Recall

Each time you send a message, before the agent responds, eunoe uses it as a
search query over every tool output that is no longer in context and
everything the agent said while working. Matching excerpts are quoted
exactly and appended to your message, oldest first.

```
you     (turn 71)   deploy is failing with ERR_LEASE_6011 again

        eunoe appends:

        <recalled-context>
        [turn 12] Bash `bun run deploy:staging`
            Deployment ID: dpl_qgthe6u4p7
            ERR_LEASE_6011: lease expired, retrying with --fresh
        </recalled-context>
```

Candidates come from BM25, the keyword ranking that search engines use,
which takes about 6 ms and no model. Optionally [Jev](https://typesafe.ai),
a small and very fast model, reorders the top 30 in about 300 ms, which
lifted the right excerpt from 88% to 95% of questions and beat every other
method and model that was tested. Without a key the BM25 order is used and
nothing else changes. The recall is computed once per message and pinned to
it, so it never disturbs the cache.

## How it plugs in

```
Claude Code  ------>  eunoe  ------>  api.anthropic.com
CLI, desktop app,     127.0.0.1:38663
Agent SDK             rewrites /v1/messages
                      passes everything else through
```

Claude Code honours `ANTHROPIC_BASE_URL` from its `settings.json`, so every
harness built on it works with no code changes, and because auth headers are
forwarded untouched your existing login keeps working whether it is a
subscription or an API key.

Claude Code still keeps the whole conversation on disk at
`~/.claude/projects/<project>/<session>.jsonl`, since eunoe only changes
what goes out on the wire.

## The transcript

Nothing is ever lost, because eunoe keeps a readable copy of the whole
session and teaches the agent to use it. The session file is rendered into a
folder of markdown under `~/.eunoe/transcripts/<session>/`, with one file
per turn and an index.

```
index.md        one line per turn: what you asked and how the turn ended
turn-0001.md    ## User            your message
turn-0002.md    ### [tool 3/12]    every tool call, with its full output below it
...             ## Final reply     the agent's reply
turn-0002-subagent-1.md            the whole run of a subagent launched in that turn
```

A subagent's run is its own file, indexed under the turn that launched it
and linked from the Agent call; the turn itself only has the subagent's
report. What the subagent saw and ran is also part of recall, labelled
`subagent "…"`, so the agent gets a value only its subagent printed without
having to look.

Markdown is far easier for an agent to grep and read than Claude Code's raw
JSONL, and the folder is rebuilt as the session grows. The agent is given the
path and a short recipe for searching it, so when it needs an exact detail
that neither evidence nor recall surfaced, it can find it in a couple of
commands instead of guessing. In the benchmark that happened about once
every ten sessions.

## Prompt caching

Cache writes cost 1.25 times the input price and reads a tenth of it, so a
context scheme that breaks the cache costs more than it saves. eunoe's
output is deterministic, which means the same history always produces the
same bytes, recall is pinned to the message it was computed for and nothing
time-based is ever inserted, so the prefix only ever changes at a fold.

```
turns  1-20   byte-identical to no proxy at all   -> cache hits as usual
turn   21     fold: one new prefix, written once  -> one cache write
turns  22-58  same prefix, new turns appended     -> reads hit again
turn   59     next fold
```

Measured through the proxy right after a fold, 180k tokens came from the
cache and 1.5k were written. Claude Code's own compaction reads the entire
context into a summary call and then writes a new prefix anyway.

## Modes

| mode | |
|---|---|
| **`default`** | everything above, recommended |
| **`compact`** | only the compaction is replaced: the context grows as it normally would, and at the limit eunoe folds instead of summarising, so you get the recall but none of the savings along the way |
| **`off`** | passthrough, Claude Code compacts on its own |

```sh
eunoe mode           # pick one
eunoe mode compact   # or name it
```

Whichever mode is on owns compaction, so eunoe disables Claude Code's
auto-compact while it is active and hands it back on `off` or `stop`.

## Usage

```sh
eunoe start                  # route Claude Code through eunoe (sets up the proxy the first time)
eunoe stop                   # new sessions bypass eunoe; running ones keep working
eunoe mode                   # pick default | compact | off
eunoe settings               # pick a setting and change it
eunoe settings list          # show them all
eunoe settings set keep 5    # change one directly
eunoe status                 # what's running, every session, context and tokens saved
eunoe stats                  # tokens and API cost by day (--days 14, --weekly), and what eunoe saved
eunoe replay                 # replay your whole Claude Code history through eunoe, offline, and see what it saves
eunoe uninstall              # stop and remove the background proxy
```

`ee` is an alias, so `ee status` and `eunoe status` are the same command.

### Earlier sessions

A different big problem with Claude is that new chats always start cold. eunoe
helps you carry an earlier session into one: run `eunoe sessions`, pick the
session (type to filter), and paste the copied `{ee:continue:<id>}` marker into
the chat along with what you want done. eunoe attaches that whole session to
the message, folded the same way it folds turns in a live session: your
messages, the key output lines and the agent's replies, in order. From then on
the earlier session's dropped tool output is searchable too, so an exact value
from it comes back as recalled context when a later message is about it.

You always name the session. eunoe never guesses which one you mean or injects
one on its own; in the benchmark that choice was wrong a third of the time,
while a named session remembered 98% of its facts and kept 95% of its rules.

```sh
eunoe sessions [words]       # browse earlier sessions here; enter copies {ee:continue:<id>}
```

The agent is also taught two commands for digging on its own: `eunoe load
<id>` writes a session to `~/.eunoe/loaded/<id>.md` for it to read whole, and
`eunoe peek <id> <words>` prints just the excerpts that match.

### Per session

Everything above takes `--session <id>` to apply to one session only. Session
ids are in Claude Code's `/status`, `eunoe status` lists the ones it has seen
with their working directory, and a unique prefix is enough.

```sh
eunoe start --session 1baada86        # manage only this session, pass the rest through untouched
eunoe mode compact --session 1baada86
eunoe settings set keep 5 --session 1baada86
eunoe settings set keep default --session 1baada86   # back to the shared value
eunoe stop --session 1baada86
```

Sessions that aren't managed still go through the proxy, so any of them can
be switched on later without a restart, and every change applies from the
session's next request.

### Settings

| key | default | what it does |
|---|---|---|
| `keep` | `3` | turns kept whole at the end |
| `budget` | `100000` | tokens of older detail that trigger a fold |
| `turnCap` | `100000` | a kept turn larger than this is folded at once, the live turn excepted; `off` to disable |
| `compactAt` | `0.9` | share of the context window that triggers the full cut |
| `keepTurns` | `all` | folded turns kept after a full cut |
| `search` | `markdown` | transcript form for the agent: `markdown`, `xml`, `jsonl` or `qmd` (semantic, via [qmd](https://github.com/tobi/qmd)) |
| `rerank` | `jev-preview` | Typesafe model that reorders recall, or `off` |

`~/.eunoe/config.json` holds the same keys plus `port`, `claudeConfigDirs`
and `sessions`. Tools that run Claude Code from their own config directory
need eunoe to know about it, which `eunoe start --config-dir <dir>` does
once and remembers.

### Better recall with Jev

Recall works out of the box, but it gets noticeably better with
[Jev](https://typesafe.ai) reordering the candidates. To turn that on, put a
Typesafe API key in `~/.eunoe/typesafe-key` or in the `TYPESAFE_API_KEY`
environment variable, and `eunoe status` will show the reranker as active.
The cost is time: the first request of each new message waits for Jev, about
300 ms and at most four seconds, after which the recall falls back to the
plain keyword order. Every other request is unaffected. To switch it off, run
`eunoe settings set rerank off`.

### Logs

Every request is written to `~/.eunoe/requests.jsonl` with what eunoe did
to it and how much of it the API served from cache, which is also where
`eunoe status` gets its numbers.

`eunoe stats` reads the usage the API returned, from Claude Code's own session
files, subagents included, so it covers every session, routed through eunoe or
not. Claude Code writes one response as several lines, so each response is
counted once, with its final output count. Cost is at API list prices.
Its eunoe columns are only what eunoe actually did, from its request log: the
input tokens it kept out, and what that saved. Those tokens are mostly history
plain Claude Code would have read from cache, so they are priced as cache
reads, and every token a fold rewrote is charged back at the cache-write price.
`eunoe replay` and `eunoe stats` can only see what is still on disk: Claude Code
deletes sessions that have been idle for 30 days unless `cleanupPeriodDays` in
its `settings.json` says otherwise.

## Embedding

The proxy is one host of a small library. Anything that sends Anthropic
Messages requests can use the same folding, recall and estimates: a
forwarding server, an agent loop of your own, a Cloudflare Durable Object,
another proxy. The core reads no files, no environment and no global
config, and it runs in Node, Bun, Deno and Workers.

```sh
npm install @chroxify/eunoe
```

```ts
import { CORE_DEFAULTS, memoryStore, rewrite } from "@chroxify/eunoe"

const store = memoryStore()
const { body, note } = rewrite({
  body: request,             // the Messages request you were about to send
  threadId: conversationId,  // anything stable per conversation
  config: { ...CORE_DEFAULTS, mode: "compact" },
  store,
  window: 200_000,           // the model's context window
  mayCompact: true,          // false for count_tokens and other side calls
})
// send `body` instead of `request`; `note` says what happened
```

`rewrite` is a pure function of the request and the thread's saved state,
so the same history always produces the same bytes and the prompt cache
holds. Everything it needs from outside comes in through three small
pieces:

| | |
|---|---|
| `ThreadStore` | `read(key)` and `save(key, state)`, synchronous. `memoryStore()` keeps state in memory; give it your own to persist across restarts. |
| `ThreadSources` | optional: `readHistory()` for the whole conversation when you send a shortened one, `findHandoff` and `readHandoff` for `{ee:continue:…}`, `guide` and `transcriptDir` when the agent can search a transcript. |
| `Reranker` | optional, for `rewriteAsync`: reorders recall candidates. `jevReranker(model, key)` is the one the proxy uses. |

In a Durable Object, SQLite-backed storage is synchronous, so the store is
two lines:

```ts
const store = {
  read: (key) => this.ctx.storage.kv.get(key) ?? {},
  save: (key, state) => this.ctx.storage.kv.put(key, state),
}
```

### Folding at a boundary you know

A host often knows better than any token count when a step is over. After a
planning step, fold every earlier turn and keep only the plan whole:

```ts
import { foldThread, pinTurns } from "@chroxify/eunoe"

messages.push({ role: "user", content: "Build step one." })
foldThread({ store, threadId, messages }, { at: "latest", pin: [planTurn] })
```

Turns are numbered as `note.cutTurn` numbers them, from 0 for the first
prompt, and the boundary must be a turn that already exists, so fold once
the next step's prompt is in the list. Every turn before the boundary is
folded to the user's message, the evidence and the reply. Pinned turns are
sent whole, with their tool calls, and stay whole even when a later
automatic cut drops the turns around them. `pinTurns(target, [n], false)`
releases one. A host fold applies in every mode, `off` included, and its
output stays byte-stable from one request to the next.

### The note

Every call returns a note: `action` (`pass`, `full` or `compact`),
`cutTurn`, `folded`, `omitted`, `pinned`, `estimate` in tokens, `fit` when
the request had to be trimmed to fit (`recut`, `bare` or `over`), and
`stuck` when even the cut leaves it over its target. `stuck` gives the
tokens in each part (`fixed`, `head`, `folded`, `live`) so the host can
act: start a fresh conversation with a handoff, or fold at its own
boundary. While a thread is stuck, eunoe holds what it cleared still
instead of clearing a little more on every request, so the cache keeps
hitting.

### The whole proxy as one call

`createForwarder` is the proxy's request loop as a fetch handler: it
rewrites each `/v1/messages` request, forwards everything to the API,
streams the answer back, learns the thread's real token ratio from the
answer's `usage`, retries once with a corrected size after a "prompt is
too long", retries a stalled `count_tokens`, and looks the context window
up from the Models API. `eunoe serve` is this call with a file-backed
store, Claude Code's session files as sources and a request log.

```ts
import { CORE_DEFAULTS, createForwarder, memoryStore } from "@chroxify/eunoe"

const forward = createForwarder({ store: memoryStore(), config: CORE_DEFAULTS })
Bun.serve({ port: 8787, fetch: forward })          // or Deno.serve, a Worker's fetch, …
```

Threads are told apart by an `x-thread-id` header, or Claude Code's own
session id; pass `threadIdOf`, `sources`, `reranker`, `window` or `record`
to change any part, or `prepare` to take the rewrite over entirely. A host
that calls the API itself gets the same calibration with
`recordUsage(store, threadKey, sentBody, usage)` and
`recordOverflow(store, threadKey, sentBody, errorText)`.

| export | |
|---|---|
| `rewrite`, `rewriteAsync` | rewrite one request for one thread; the async one takes a reranker |
| `foldThread`, `pinTurns` | fold at your own boundary, keep chosen turns whole |
| `createForwarder` | the full proxy loop as a `(Request) => Promise<Response>` |
| `recordUsage`, `recordOverflow` | feed what the API said back into the thread's estimates |
| `createWindowLookup` | a model's context window from the Models API, cached |
| `memoryStore`, `threadKeyOf` | in-memory state, and the key a thread is saved under |
| `jevReranker`, `continueToken`, `watchUsage`, `claudeCodeSessionId` | the pieces the proxy uses, for hosts that want them |

What stays in the proxy is what only makes sense next to Claude Code on
your machine: reading its session files and subagent runs, finding earlier
sessions for `{ee:continue:…}`, rendering the markdown transcript, the
config file and the CLI.

[`examples/`](examples) runs as it is. [`tour.ts`](examples/tour.ts) walks
through every feature on real inputs and prints what each did: folding,
the full cut, evidence, recall, recall from host history, reranking,
handoffs, host folds and pins, `stuck`, calibration, custom storage and the
forwarder. The others are hosts: a
[forwarding server](examples/forwarding-server.ts) on `node:http` with a
`/fold` endpoint, a [custom agent loop](examples/agent-loop.ts) that folds
at each step and keeps its plan pinned, and a
[Claude Code proxy](examples/proxy.ts) with a file-backed store.

## What it doesn't do

- **It is a proxy, which makes it a single point of failure.** If it isn't
  running while `ANTHROPIC_BASE_URL` still points at it, every Claude request
  fails. Three things limit the damage: `start` refuses to route Claude Code
  until the proxy answers, launchd restarts the proxy within a second whenever
  it dies, and a watchdog that runs every 10 seconds takes eunoe out of
  `settings.json` after 20 seconds of silence and puts it back when the proxy
  answers again. A request the proxy can't deliver upstream comes back as a
  502 that Claude Code retries, never a hang. Sessions that were already
  running keep the old address until restarted, so they wait for the proxy
  rather than falling back.
- **The proxy only understands Claude Code's shape of conversation.** Other
  Anthropic API clients pass through it unchanged and get nothing out of
  it; they can [embed the library](#embedding) instead.
- **It can't recover what Claude Code already compacted,** so turn it on
  before a long session rather than after.
- **Recall is keyword search.** Ask about "the deploy that failed" and it
  finds the deploy output, but ask about "that thing from before" and it
  finds nothing, leaving the agent to search the transcript itself. Jev
  narrows this gap without closing it.
- **It never cuts against a limit it can't verify.** The context window size
  comes from the Models API for each model, and if that lookup fails the
  budget folds still happen but the full cut does not.

## Credits

- [qmd](https://github.com/tobi/qmd) by Tobi Lütke provides the local
  semantic search behind the `qmd` setting.
- [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) by
  Typesafe is the system-one model that reranks recall.

## License

eunoe is licensed under the [MIT License](LICENSE), and welcomes
contributions and suggestions.
