import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
  type Body,
  CORE_DEFAULTS,
  type CoreConfig,
  continueToken,
  createForwarder,
  foldThread,
  listSubagentRecall,
  type Message,
  memoryStore,
  pinTurns,
  type Reranker,
  recordUsage,
  renderTranscriptFiles,
  rewrite,
  rewriteAsync,
  type ThreadState,
  type ThreadStore,
  threadKeyOf,
  transcriptGuide,
} from "@chroxify/eunoe"

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const reply = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] })
const bash = (id: string, command: string, output: string): Message[] => [
  { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] },
]
const noise = (n: number) => Array.from({ length: 120 }, (_, i) => `src/module-${n}/file-${i}.ts compiled`).join("\n")
const request = (messages: Message[]): Body => ({ model: "claude-sonnet-5-5", system: "You are a coding agent.", tools: [{ name: "Bash" }], messages })
const wire = (messages: Message[]) => JSON.stringify(messages)
const show = (title: string, facts: Record<string, unknown>) => {
  process.stdout.write(
    `\n${title}\n${Object.entries(facts)
      .map(([name, value]) => `  ${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join("\n")}\n`,
  )
}

const history: Message[] = [user("set up the repo"), reply("Repo is set up.")]
for (let n = 1; n <= 12; n += 1) history.push(user(`build module ${n}`), ...bash(`b${n}`, `bun run build:${n}`, noise(n)), reply(`Module ${n} builds.`))
history.push(user("deploy staging"), ...bash("d1", "bun run deploy:staging", `${noise(99)}\nDeployment ID: dpl_tour7k2q9\nstatus: live`), reply("Staging is deployed."))
history.push(user("warm the cache"), ...bash("w1", "bun run warm", `${noise(98)}\nwarmed 812 entries under the heron namespace`), reply("Cache is warm."))
const thread = (messages: Message[], config: Partial<CoreConfig>, window: number | null, store: ThreadStore = memoryStore(), threadId = "tour") =>
  rewrite({ body: request(messages), threadId, config: { ...CORE_DEFAULTS, ...config }, store, window, mayCompact: true })

const small = [user("hi"), reply("hello"), user("what's up?")]
const untouched = thread(small, {}, 200_000)
assert.equal(wire(untouched.body.messages), wire(small))
show("1. A short thread goes upstream byte for byte", { action: untouched.note.action, messages: untouched.body.messages.length })

const live = [...history, user("now add a health check"), ...bash("h1", "ls", "app.ts")]
const rolled = thread(live, { mode: "default", budget: 5_000, keep: 1 }, 1_000_000)
assert.deepEqual(rolled.note.actions, ["roll"])
assert.ok(wire(rolled.body.messages).includes("Module 1 builds."))
assert.ok(!wire(rolled.body.messages).includes("src/module-1/file-7.ts"))
assert.ok(wire(rolled.body.messages).includes("dpl_tour7k2q9"))
show("2. Rolling folds: finished turns fold to prompt, evidence and reply; the last few stay whole", {
  config: "mode default, budget 5000 tokens, keep 1",
  actions: rolled.note.actions,
  messages: `${rolled.note.messagesIn} → ${rolled.note.messagesOut}`,
  cutTurn: rolled.note.cutTurn,
  evidenceKept: "Deployment ID: dpl_tour7k2q9 survives in the folded deploy turn",
})

const cut = thread(live, { mode: "compact" }, 15_000)
assert.equal(cut.note.compacted, true)
assert.ok((cut.note.estimate ?? 0) < 0.9 * 15_000)
show("3. Full cut at the limit: compact mode folds only when the request nears the window", {
  config: "mode compact, compactAt 0.9, window 15000",
  actions: cut.note.actions,
  cutTurn: cut.note.cutTurn,
  estimate: cut.note.estimate,
})

const asking = [...history, user("which namespace did the cache warmup use?")]
const recallStore = memoryStore()
const firstAsk = thread(asking, { mode: "compact" }, 15_000, recallStore)
const recalled = thread(asking, { mode: "compact" }, 15_000, recallStore)
assert.equal(wire(recalled.body.messages), wire(firstAsk.body.messages))
assert.ok(wire(recalled.body.messages).includes("heron namespace"))
show("4. Recall: a prompt about dropped output gets the exact lines back, pinned to that prompt", {
  prompt: "which namespace did the cache warmup use?",
  recalledChars: firstAsk.note.recalled,
  secondCall: "same bytes: the recall is saved with the thread, so the cache holds",
  recalledLine: "warmed 812 entries under the heron namespace",
})

const shortened = [user("set up the repo"), reply("Repo is set up."), user("what deployment id did staging print?")]
const fromHistory = rewrite({ body: request(shortened), threadId: "host-history", config: CORE_DEFAULTS, store: memoryStore(), sources: { readHistory: () => history }, window: null, mayCompact: true })
assert.ok(wire(fromHistory.body.messages).includes("dpl_tour7k2q9"))
show("5. Recall from a history the host keeps itself", { sources: "readHistory: () => fullConversation", recalled: fromHistory.note.recalled })

const asked: string[] = []
const reranker: Reranker = (query, _chunks, candidates) => {
  asked.push(query)
  return Promise.resolve([...candidates].reverse())
}
const reranked = await rewriteAsync({ body: request(shortened), threadId: "reranked", config: CORE_DEFAULTS, store: memoryStore(), sources: { readHistory: () => history }, window: null, mayCompact: true }, reranker)
show("6. A reranker orders recall candidates (jevReranker is the one the proxy uses)", { rerankerCalls: asked.length, recalled: reranked.note.recalled })

const earlier = [user("always use the yalsho/ branch prefix"), reply("Noted, yalsho/ it is.")]
const handedOff = rewrite({
  body: request([user(`${continueToken("prior-session-0001")} pick up the branch work`)]),
  threadId: "new-session",
  config: CORE_DEFAULTS,
  store: memoryStore(),
  sources: { findHandoff: (id) => (id === "prior-session-0001" ? { label: "Branch rules", source: id } : null), readHandoff: () => earlier },
  window: null,
  mayCompact: true,
})
assert.ok(wire(handedOff.body.messages).includes("yalsho/"))
show("7. Handoffs: {ee:continue:id} brings a folded earlier session into the prompt", { token: continueToken("prior-session-0001"), from: handedOff.note.handoffFrom })

const planned: Message[] = [user("plan the release"), reply("PLAN: 1. tag 2. changelog 3. publish"), user("tag it"), ...bash("t1", "git tag v2", "tagged"), reply("Tagged."), user("write the changelog")]
const host = memoryStore()
const folded = foldThread({ store: host, threadId: "steps", messages: planned }, { at: "latest", pin: [0] })
const afterFold = rewrite({ body: request(planned), threadId: "steps", config: { ...CORE_DEFAULTS, mode: "off" }, store: host, window: null, mayCompact: true })
assert.ok(wire(afterFold.body.messages).includes("PLAN: 1. tag"))
assert.ok(!wire(afterFold.body.messages.slice(0, -1)).includes('"tagged"'))
show("8. Host folds: fold at a step boundary you know, keep the plan whole, in any mode", {
  call: "foldThread({ store, threadId, messages }, { at: 'latest', pin: [0] })",
  result: folded,
  note: { action: afterFold.note.action, folded: afterFold.note.folded, pinned: afterFold.note.pinned, host: afterFold.note.host },
})
const released = pinTurns({ store: host, threadId: "steps", messages: planned }, [0], false)
show("9. Pins can be released", { pinned: released.pinned })

const huge = [user("first"), reply("ok"), user(`review this dump ${"x".repeat(700_000)}`), ...bash("r1", "ls", "a")]
const stuck = thread(huge, { mode: "compact" }, 200_000)
assert.ok(stuck.note.stuck)
show("10. Stuck: when even the cut can't fit, the note says where the size is", { stuck: stuck.note.stuck })

const calibrated = memoryStore()
const first = thread(live, { mode: "compact" }, 1_000_000, calibrated, "calibrated")
const key = threadKeyOf("calibrated", live) as string
const codeHeavyTokens = Math.round(JSON.stringify(first.body).length / 2.76)
recordUsage(calibrated, key, first.body, { input_tokens: 2, cache_read_input_tokens: codeHeavyTokens })
show("11. Calibration: feed back usage and estimates use this thread's real token ratio", {
  ratio: calibrated.read(key).ratio?.toFixed(3),
  estimateBefore: first.note.estimate,
  estimateAfter: thread(live, { mode: "compact" }, 1_000_000, calibrated, "calibrated").note.estimate,
})

const saved = new Map<string, string>()
const jsonStore: ThreadStore = { read: (k) => JSON.parse(saved.get(k) ?? "{}") as ThreadState, save: (k, state) => saved.set(k, JSON.stringify(state)) }
thread(live, { mode: "compact" }, 15_000, jsonStore, "persisted")
show("12. Any storage: the store is just read and save", { keys: [...saved.keys()], state: Object.keys(JSON.parse([...saved.values()][0])) })

const upstream = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(chunk as Buffer)
  const received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body
  outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ received: received.messages.length, usage: { input_tokens: 5, cache_read_input_tokens: 9_000 } }))
})
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
const forward = createForwarder({ store: memoryStore(), upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, config: { ...CORE_DEFAULTS, mode: "compact" }, window: 15_000 })
const answer = await forward(new Request("http://localhost/v1/messages", { method: "POST", headers: { "x-thread-id": "forwarded" }, body: JSON.stringify(request(live)) }))
const answered = (await answer.json()) as { received: number }
upstream.close()
assert.ok(answered.received < live.length)
show("13. createForwarder: the whole proxy loop as one fetch handler", { sent: live.length, upstreamReceived: answered.received, plus: "ratio learning from usage, one retry on prompt-too-long, count_tokens retries" })

const transcriptFiles = renderTranscriptFiles(live)
const stored = new Map(Object.entries(transcriptFiles).map(([name, body]) => [`threads/tour/transcript/${name}`, body]))
const guided = rewrite({
  body: request(live),
  threadId: "transcribed",
  config: { ...CORE_DEFAULTS, mode: "compact" },
  store: memoryStore(),
  sources: { guide: transcriptGuide("threads/tour/transcript"), transcriptDir: "threads/tour/transcript" },
  window: 15_000,
  mayCompact: true,
})
assert.ok(stored.get("threads/tour/transcript/turn-0014.md")?.includes("dpl_tour7k2q9"))
assert.ok(wire(guided.body.messages).includes("threads/tour/transcript"))
show("14. Transcript: render your own messages to per-turn files, store them anywhere, point the agent at them", {
  files: `${stored.size} (index.md + one per turn)`,
  deployTurn: "threads/tour/transcript/turn-0014.md has the full deploy output",
  guide: "transcriptGuide(dir) goes into sources.guide; the cut's notice tells the agent to grep there",
})

const launched: Message[] = [
  user("why is CI red?"),
  { role: "assistant", content: [{ type: "tool_use", id: "agent1", name: "Agent", input: { description: "find the flaky test", prompt: "find it" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "agent1", content: "It is the retry test." }] },
  reply("The retry test is flaky."),
  user("which seed made the retry test fail?"),
]
const subagents = [{ description: "find the flaky test", toolUseId: "agent1", messages: [user("find it"), ...bash("s1", "bun test --seed 4242", "FAIL retry.test.ts with seed 4242"), reply("It is the retry test.")] }]
const withSubagent = rewrite({ body: request(launched), threadId: "subagents", config: CORE_DEFAULTS, store: memoryStore(), sources: { listSubagentChunks: () => listSubagentRecall(launched, subagents) }, window: null, mayCompact: true })
const subagentFiles = renderTranscriptFiles(launched, { subagents })
assert.ok(wire(withSubagent.body.messages).includes("seed 4242"))
assert.ok(subagentFiles["turn-0001-subagent-1.md"]?.includes("seed 4242"))
show("15. Subagents: what only a subagent saw comes back through recall and gets its own transcript file", {
  recalled: withSubagent.note.recalled,
  file: "turn-0001-subagent-1.md, linked from the Agent call in turn-0001.md",
})
