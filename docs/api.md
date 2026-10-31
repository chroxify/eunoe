# eunoe API reference

Everything `@chroxify/eunoe` exports, with its exact signature, what it does
and an example. The proxy (`eunoe serve`) is built from these same exports,
so a host that calls them runs the same code the proxy runs.
[`examples/tour.ts`](../examples/tour.ts) runs every one of them on real
inputs; `node examples/tour.ts` after `bun run build:core`.

```ts
import { CORE_DEFAULTS, createForwarder, foldThread, memoryStore, rewrite } from "@chroxify/eunoe"
```

- [Where state and data live](#where-state-and-data-live)
- [Rewriting requests](#rewriting-requests): `rewrite`, `rewriteAsync`, `RewriteInput`, `Rewrite`, `RewriteNote`, `StuckSizes`
- [Configuration](#configuration): `CORE_DEFAULTS`, `CoreConfig`, `Mode`
- [Thread state](#thread-state): `ThreadStore`, `ThreadState`, `memoryStore`, `threadKeyOf`
- [Sources](#sources): `ThreadSources`
- [Recall](#recall): `Reranker`, `RecallChunk`, `jevReranker`
- [Host folds](#host-folds): `foldThread`, `pinTurns`, `FoldTarget`, `FoldOptions`, `Folded`
- [Transcripts](#transcripts): `renderTranscriptFiles`, `TranscriptOptions`, `transcriptGuide`
- [Subagents](#subagents): `listSubagentRecall`, `Subagent`
- [Handoffs](#handoffs): `continueToken`
- [The forwarder](#the-forwarder): `createForwarder`, `ForwarderOptions`, `Prepared`, `ForwardNote`, `claudeCodeSessionId`
- [Calibration and usage](#calibration-and-usage): `recordUsage`, `recordOverflow`, `inputTokens`, `watchUsage`, `Usage`
- [Context windows](#context-windows): `createWindowLookup`, `WindowLookup`
- [Payload types](#payload-types): `Body`, `Message`, `Block`

## Where state and data live

The library never touches a disk, the network (except the forwarder, the
window lookup and the Jev reranker, which call the URLs you give them) or
the environment. Everything it keeps or reads goes through the host:

| What | Who keeps it | How it gets in |
|---|---|---|
| Thread state: the cut, folds, pins, the recall picked for each prompt, handoffs, the learned token ratio | you, in any key-value storage | a [`ThreadStore`](#thread-state) (`read` / `save`) |
| What recall searches | nobody: it is the request itself | the tool output in the `body` you pass. Old output still in the request is what a fold drops, and what recall brings back |
| The full conversation, when you send a shortened one | you | `sources.readHistory` |
| The searchable transcript the agent greps | you, anywhere | write the files from [`renderTranscriptFiles`](#transcripts), then pass `sources.guide` and `sources.transcriptDir` |
| Earlier sessions for `{ee:continue:…}` | you | `sources.findHandoff` / `sources.readHandoff` |
| What subagents saw and printed | you | [`listSubagentRecall`](#subagents) into `sources.listSubagentChunks`, and `subagents` in `renderTranscriptFiles` |
| Context window per model | in memory, or wherever `onLearn` writes | [`createWindowLookup`](#context-windows) |

So recall needs no setup at all. The transcript is optional and lives where
you put it. The proxy fills these slots with `~/.eunoe/threads`, Claude
Code's own session files and `~/.eunoe/transcripts`.

## Rewriting requests

### `rewrite(input: RewriteInput): Rewrite`

Rewrites one Anthropic Messages request for one thread, synchronously. It
reads the thread's state from `input.store` and decides whether to fold,
cut or pass. It attaches recall and handoffs, saves the state back, and
returns the body to send instead. The same history and state always give
the same bytes, so the prompt cache holds.

```ts
const store = memoryStore()
const { body, note } = rewrite({
  body: request,
  threadId: "conversation-42",
  config: CORE_DEFAULTS,
  store,
  window: 200_000,
  mayCompact: true,
})
await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) })
```

### `rewriteAsync(input: RewriteInput, reranker?: Reranker): Promise<Rewrite>`

The same, plus an async reranker that reorders recall candidates the first
time a prompt is seen. Without a reranker it is `rewrite`.

```ts
const out = await rewriteAsync(input, jevReranker("jev-preview", process.env.TYPESAFE_API_KEY!))
```

### `RewriteInput`

| field | type | |
|---|---|---|
| `body` | `Body` | the request you were about to send |
| `threadId` | `string \| null` | anything stable per conversation; `null` passes the request through |
| `config` | `CoreConfig` | start from `CORE_DEFAULTS` |
| `store` | `ThreadStore` | where this thread's state lives |
| `sources` | `ThreadSources?` | what else the host can supply; all optional |
| `window` | `number \| null` | the model's context window in tokens; `null` turns off the cut near the limit (rolling folds and host folds still happen) |
| `mayCompact` | `boolean` | `false` for `count_tokens` and other side calls: they are rewritten but never move the cut |
| `omittedBefore` | `number?` | turns the host already dropped before this body, so the notice counts them |

### `Rewrite`

`{ body: Body; threadKey: string | null; note: RewriteNote }`. `threadKey`
is the key the state was saved under (see `threadKeyOf`).

### `RewriteNote`

What happened, for logs and for the host to act on:

| field | |
|---|---|
| `action` | `"pass"` (untouched), `"full"` (whole history, only the system note added), `"compact"` (folded); `"guide"`, `"trim"`, `"tail"` for benchmark arms |
| `compacted`, `actions` | whether this request moved the cut, and the steps: `"roll"`, `"cut"`, `"keep=N"`, `"cleared=N"`, `"stuck"` |
| `cutTurn` | the first turn sent whole; turns before it are folded |
| `folded`, `omitted`, `pinned` | how many earlier turns are folded, dropped entirely, kept whole by a pin |
| `host` | `true` when the current cut is one the host set with `foldThread` |
| `keep`, `cleared` | after shrinking: folded turns kept, tool results cleared in the live turn |
| `estimate`, `window` | tokens this request is estimated at, against the window |
| `fit`, `fitEstimate` | when the first pass was still over the limit: `"recut"`, `"bare"` (the live prompt's recall left out, for good), `"over"` |
| `recalled` | characters of recall attached to this prompt (first time only) |
| `handoff`, `handoffFrom` | size and label of attached handoffs |
| `stuck` | a `StuckSizes`, while even the cut leaves the request over `compactAt × window` |

### `StuckSizes`

`{ fixed, head, folded, live }`: tokens in the system prompt and tools,
the first message and notice, the folded turns, and the live turn. When
`live` dominates, a single turn is bigger than the window allows; start a
new thread with a handoff, or fold at your own boundary. While stuck, the
cleared set holds still; eunoe clears again only when that makes the
request fit or brings it back under the window, so the cache keeps hitting.
`stuck` goes away once a request fits.

## Configuration

### `CORE_DEFAULTS: CoreConfig`

`{ mode: "default", compactAt: 0.9, keepTurns: "all", keep: 3, budget: 100_000, turnCap: 100_000 }`,
the same defaults as the proxy.

### `CoreConfig`

| field | default | |
|---|---|---|
| `mode` | `"default"` | `"default"`: rolling folds plus the cut near the limit. `"compact"`: only the cut near the limit. `"off"`: nothing automatic; host folds still apply |
| `budget` | `100_000` | tokens of older detail that trigger a rolling fold |
| `keep` | `3` | finished turns kept whole at the end by a rolling fold |
| `compactAt` | `0.9` | share of the window that triggers the cut |
| `keepTurns` | `"all"` | folded turns kept after the cut; a number drops older ones entirely |
| `turnCap` | `100_000` | a single earlier turn bigger than this many tokens is folded at once; `"off"` to disable |
| `eval` | | benchmark switches (`strategy`, `rolling`, `forceCut`, `recall`, `rerank`, `evidence`, `recallOptions`); leave unset |

```ts
const foldOften = { ...CORE_DEFAULTS, budget: 20_000, keep: 1 }
const foldLate = { ...CORE_DEFAULTS, mode: "compact" as const, compactAt: 0.95 }
const onlyWhereISay = { ...CORE_DEFAULTS, mode: "off" as const }
```

### `Mode`

`"default" | "compact" | "off"`.

## Thread state

### `ThreadStore`

```ts
interface ThreadStore {
  read: (key: string) => ThreadState
  save: (key: string, state: ThreadState) => void
}
```

Synchronous, so a rewrite never interleaves with another one's state. Return
`{}` for an unknown key. Examples:

```ts
const files: ThreadStore = {
  read: (key) => (existsSync(`${dir}/${key}.json`) ? JSON.parse(readFileSync(`${dir}/${key}.json`, "utf8")) : {}),
  save: (key, state) => writeFileSync(`${dir}/${key}.json`, JSON.stringify(state)),
}

const durableObject: ThreadStore = {
  read: (key) => this.ctx.storage.kv.get(key) ?? {},
  save: (key, state) => this.ctx.storage.kv.put(key, state),
}
```

### `ThreadState`

The JSON a store holds per thread. Treat it as opaque. It contains the cut
turn's key, `keep`, `cleared`, `stuck`, `host`, `pins`, `ratio`, `limits` (per
model, the input limit a "prompt is too long" error named, which caps the
window for that model in the thread), `recalls` (the recall text per prompt still in context) and
`handoffs`. A turn's key is its prompt's fingerprint, with `~n` added for
the nth repeat of the same prompt. It is small: fingerprints and
the recalled text, never the conversation.

### `memoryStore(initial?: Record<string, ThreadState>): ThreadStore`

An in-memory store, for tests, short-lived workers, or as a cache you
flush yourself.

### `threadKeyOf(threadId: string, messages: Message[]): string | null`

The key a thread's state is saved under: the thread id plus a fingerprint
of the first prompt, so a rewound or restarted conversation starts fresh.
`null` when there is no user turn yet.

## Sources

### `ThreadSources`

Everything optional; give what your host has.

| field | |
|---|---|
| `readHistory?: () => Message[]` | the whole conversation, for recall when the body you send is already shortened |
| `listSubagentChunks?: () => RecallChunk[]` | extra recall material, such as what subagents printed |
| `findHandoff?: (id) => { label, source } \| null` | resolve a `{ee:continue:id}` to an earlier session |
| `readHandoff?: (source) => Message[]` | that session's messages; it is folded and attached to the prompt |
| `guide?: string \| null` | text telling the agent where its transcript is (see `transcriptGuide`) |
| `transcriptDir?: string \| null` | the folder named in cleared-output placeholders |

## Recall

Recall is automatic. When a fold drops tool output and a later prompt is
about it, the matching lines are attached to that prompt as
`<recalled-context>`. It is computed once per prompt and saved in the
thread state, so later requests send the same bytes.

### `Reranker`

`(query: string, chunks: RecallChunk[], candidates: number[]) => Promise<number[]>`:
reorders candidate indices, best first. Pass it to `rewriteAsync`.

### `RecallChunk`

`{ turn, from?, call, lines, terms }`: one window of tool output, with the
call that produced it.

### `jevReranker(model: string, key: string, endpoint?: string, onError?: (reason: string) => void): Reranker`

Typesafe's Jev model as a reranker, the one the proxy uses when a key is set.
Falls back to the keyword order on any error, with `onError` told why.

## Host folds

### `foldThread(target: FoldTarget, options?: FoldOptions): Folded`

Folds now, at a boundary you know, in any mode: every turn before `at` is
folded to the user's message, its evidence and the reply, and pinned turns
are sent whole. Throws `RangeError` for a turn that doesn't exist.

```ts
messages.push({ role: "user", content: "Build step one." })
foldThread({ store, threadId, messages }, { at: "latest", pin: [planTurn] })
```

### `pinTurns(target: FoldTarget, turns: number[], pinned = true): Folded`

Keeps turns whole whatever folds around them (`pinned = false` releases
them). Pins outlive later cuts.

### `FoldTarget`, `FoldOptions`, `Folded`

- `FoldTarget`: `{ store: ThreadStore; threadId: string; messages: Message[] }`.
- `FoldOptions`: `{ at?: number | "latest"; pin?: number[] }`. Turns are numbered from 0 for the first prompt, as in `note.cutTurn`. `at` must name an existing turn from 1 up.
- `Folded`: `{ threadKey: string; cutTurn: number | null; pinned: number[] }`.

## Transcripts

### `renderTranscriptFiles(messages: Message[], options?: TranscriptOptions): Record<string, string>`

Renders your own messages into the same files the proxy writes to
`~/.eunoe/transcripts/<session>/`: `index.md`, and one `turn-NNNN.md` per
turn with every tool call and its full output. Each subagent run also gets
a `turn-NNNN-subagent-K.md`, linked from the call that launched it. Store
the files anywhere the agent can read: a folder, a sandbox, R2, Durable
Object storage.

### `TranscriptOptions`

`{ format?: "markdown" | "xml"; subagents?: Subagent[] }`. Markdown is the default.

### `transcriptGuide(dir: string, format?: "markdown" | "xml"): string`

The instructions that tell the agent where those files are and how to
search them. Pass the text as `sources.guide` and `dir` as `sources.transcriptDir`.

```ts
const dir = `/workspace/.transcripts/${threadId}`
for (const [name, text] of Object.entries(renderTranscriptFiles(messages))) await writeFile(`${dir}/${name}`, text)
rewrite({ ...input, sources: { guide: transcriptGuide(dir), transcriptDir: dir } })
```

## Subagents

The proxy reads Claude Code's subagent runs from disk. A host that runs its
own subagents passes their messages in instead.

### `Subagent`

`{ description: string; messages: Message[]; toolUseId?: string }`. `toolUseId`
is the id of the tool call that launched the run in the parent thread; it
ties the run to its turn.

### `listSubagentRecall(parentMessages: Message[], subagents: Subagent[]): RecallChunk[]`

What the subagents' tools printed, as recall material labelled
`subagent "<description>"`. A value only a subagent saw then comes back when
the parent is asked about it.

```ts
rewrite({ ...input, sources: { listSubagentChunks: () => listSubagentRecall(messages, subagents) } })
renderTranscriptFiles(messages, { subagents })
```

## Handoffs

### `continueToken(id: string): string`

`{ee:continue:<id>}`. Put it in a prompt and give `findHandoff` /
`readHandoff` in sources, and the earlier session is folded and attached
to that prompt, with its tool output added to recall.

## The forwarder

### `createForwarder(options: ForwarderOptions): (request: Request) => Promise<Response>`

The proxy's whole request loop as a fetch handler. For each request it
rewrites `/v1/messages`, forwards everything to the API and streams the
answer back. It learns the thread's token ratio from the answer's `usage`
and retries once after "prompt is too long", built against the limit the
error names. It
retries a `count_tokens` call that times out (three tries), and answers 502
when the API can't be reached.

```ts
const forward = createForwarder({ store: memoryStore(), config: CORE_DEFAULTS })
Bun.serve({ port: 8787, fetch: forward })
```

### `ForwarderOptions`

| field | default | |
|---|---|---|
| `store` | required | thread state |
| `upstream` | `"https://api.anthropic.com"` | where requests go |
| `config` | `CORE_DEFAULTS` | |
| `window` | Models API lookup | a fixed number, `null`, or a `WindowLookup` |
| `threadIdOf` | `x-thread-id` header, else Claude Code's session id | how requests map to threads |
| `sources` | none | `(threadId, request, body) => ThreadSources` |
| `reranker` | none | for recall |
| `prepare` | built from the fields above | `(request, body, mayCompact) => Promise<Prepared>`: take the rewrite over entirely; the proxy uses this for Claude Code's sessions |
| `record` | none | called with one log entry per request (the fields of `~/.eunoe/requests.jsonl`) |
| `countTokensTimeoutMs` | `10_000` | |

### `Prepared`, `ForwardNote`

`Prepared` is a `Rewrite` whose note may carry extra fields of yours
(`ForwardNote`); they end up in the `record` entry.

### `claudeCodeSessionId(headers: Headers, body: Body): string | null`

Claude Code's session id, from `x-claude-code-session-id` or the request's
`metadata.user_id`.

## Calibration and usage

Estimates start at 1 token per 3.6 characters. Code-heavy threads run
nearer 1 per 2.8, so feed what the API reports back in. The forwarder
does this on its own.

### `recordUsage(store, threadKey, sent: Body | number, usage: Usage): boolean`

Saves this thread's real ratio: input tokens over characters sent.
`false` when the usage had no input.

```ts
const { body, threadKey } = rewrite(input)
const answer = await anthropic.messages.create(body)
if (threadKey) recordUsage(store, threadKey, body, answer.usage)
```

### `recordOverflow(store, threadKey, sent: Body | number, errorText: string, model?: unknown): number | null`

After a "prompt is too long: N tokens > M" error, raises the ratio past
what the API counted, saves `M` as the thread's limit for `model` (taken
from `sent` when it is a body) and returns `N`; rewrite and send again, and
every later rewrite of the thread on that model uses the smaller of its
window and `M`. `null` for
any other error.

### `inputTokens(usage: Usage): number`

Input plus cache reads plus cache writes.

### `watchUsage(response: Response, onUsage: (usage: Usage) => void): Response`

Passes a streaming or JSON response through untouched and calls `onUsage`
once the usage appears.

### `Usage`

`Record<string, number>`: the API's `usage` object.

## Context windows

### `createWindowLookup(options?: { known?: Map<string, number>; onLearn?: (windows: Map<string, number>) => void; timeoutMs?: number; retryAfterMs?: number }): WindowLookup`

Looks a model's context window up from the Models API (`max_input_tokens`)
once and remembers it. `[1m]`-style suffixes are ignored for the lookup.
`onLearn` lets you persist the map. When the lookup fails or takes longer
than `timeoutMs` (1,500), it answers with the model family's window: 1M for
Claude 5 models, `claude-opus-4-8` and `[1m]` ids, 200K for other Claude
models, `null` for anything else. It does not ask again for that model until `retryAfterMs`
(ten minutes) has passed.

### `WindowLookup`

`(model: unknown, requestHeaders: Headers, upstream?: string) => Promise<number | null>`.
The request's auth headers are reused for the lookup.

## Hosts

- [`examples/durable-object.ts`](../examples/durable-object.ts): a Cloudflare Worker whose
  Durable Object per thread runs `createForwarder` on its `ctx.storage.kv`. It also has
  `/fold` and `/transcript` endpoints, and keeps the transcript in the same storage.
  `bun run smoke:workers` runs it in real `workerd` through Miniflare.
- [`examples/agent-loop.ts`](../examples/agent-loop.ts): your own loop calling the API, folding at each step.
- [`examples/forwarding-server.ts`](../examples/forwarding-server.ts): a `node:http` server.
- [`examples/proxy.ts`](../examples/proxy.ts): a Claude Code proxy with a file store.

## Payload types

`Body`, `Message` and `Block` are the Anthropic Messages request shapes:
`Body` has `model`, `system`, `tools`, `messages` and anything else the API
takes; `Message` is `{ role, content }`; `Block` is one content block.
