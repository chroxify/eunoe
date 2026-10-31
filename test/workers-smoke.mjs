import assert from "node:assert/strict"
import { createServer } from "node:http"
import { Miniflare } from "miniflare"

const received = []
const upstream = createServer(async (incoming, outgoing) => {
  const chunks = []
  for await (const chunk of incoming) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  received.push(body)
  outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ usage: { input_tokens: 4, cache_read_input_tokens: 9_000 } }))
})
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))

const worker = new Miniflare({
  modules: [{ type: "ESModule", path: "dist/workers/durable-object.js" }],
  compatibilityDate: "2026-08-01",
  durableObjects: { THREAD: { className: "Thread", useSQLite: true } },
  bindings: { UPSTREAM: `http://127.0.0.1:${upstream.address().port}` },
})

const user = (text) => ({ role: "user", content: [{ type: "text", text }] })
const reply = (text) => ({ role: "assistant", content: [{ type: "text", text }] })
const messages = [user("first"), reply("ok")]
for (let n = 1; n <= 12; n += 1) {
  messages.push(
    user(`deploy service ${n}`),
    { role: "assistant", content: [{ type: "tool_use", id: `d${n}`, name: "Bash", input: { command: `bun run deploy:${n}` } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `d${n}`, content: `${"uploading chunk\n".repeat(400)}Deployment ID: dpl_service${n}x9` }] },
    reply(`Service ${n} deployed.`),
  )
}
const asking = [...messages, user("which deployment id did service 3 print?")]
const call = (path, body, thread = "do-thread") => worker.dispatchFetch(`http://thread${path}`, { method: "POST", headers: { "x-thread-id": thread }, body: JSON.stringify(body) })

try {
  const answer = await call("/v1/messages", { model: "claude-sonnet-5-5", tools: [{ name: "Bash" }], messages: asking })
  assert.equal(answer.status, 200)
  await answer.text()
  const sent = received.at(-1)
  assert.ok(sent.messages.length < asking.length, "the Durable Object folded the request before forwarding it")
  assert.match(JSON.stringify(sent.messages), /<recalled-context>[\s\S]*dpl_service3x9/, "recall brought the dropped deploy output back")
  assert.match(JSON.stringify(sent.messages), /transcripts\/do-thread/, "the guide points at the host's transcript")

  await new Promise((resolve) => setTimeout(resolve, 100))
  const state = await (await call("/state", {})).json()
  const saved = Object.values(state)[0]
  assert.ok(saved.cut && saved.recalls && saved.ratio > 0, "cut, recall and the learned token ratio are in Durable Object storage")

  const planned = [user("plan the release"), reply("PLAN-DO: tag, then publish"), user("tag it"), reply("Tagged."), user("publish it")]
  const folded = await (await call("/fold", { messages: planned, pin: [0] }, "planned")).json()
  assert.deepEqual(folded.pinned, [0])
  assert.equal(folded.cutTurn, 2)
  await (await call("/v1/messages", { model: "claude-sonnet-5-5", tools: [{ name: "Bash" }], messages: planned }, "planned")).text()
  const afterFold = JSON.stringify(received.at(-1).messages)
  assert.match(afterFold, /<context-compacted>/, "the fold was saved in the planned thread's own Durable Object, so its next request is folded")
  assert.match(afterFold, /PLAN-DO: tag, then publish/, "the pinned plan is sent whole")

  const transcript = await (await call("/transcript", { messages })).json()
  assert.ok(transcript.files.includes("turn-0004.md") && transcript.files.includes("index.md"))

  process.stdout.write(`eunoe core runs in workerd: ${asking.length} → ${sent.messages.length} messages, recall and state in a Durable Object, ${transcript.files.length} transcript files\n`)
} finally {
  await worker.dispose()
  upstream.close()
}
