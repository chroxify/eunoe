import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { CORE_DEFAULTS, foldThread, memoryStore, rewrite, rewriteAsync, threadKeyOf } from "@chroxify/eunoe"

const resolved = createRequire(import.meta.url).resolve("@chroxify/eunoe")
assert.match(resolved, /dist\/core\/index\.js$/, "Node resolves the package to the built core")
assert.doesNotMatch(readFileSync(resolved, "utf8"), /from ?"(?:node:|bun)|\bBun\.|\bprocess\./, "the built core imports nothing host-only")

const declarations = readdirSync(new URL("../dist/types", import.meta.url), { recursive: true }).filter((file) => file.endsWith(".d.ts"))
for (const file of declarations) {
  const text = readFileSync(new URL(`../dist/types/${file}`, import.meta.url), "utf8")
  assert.doesNotMatch(text, /from "\.{1,2}(?:\/[^"]*)?(?<!\.js)"/, `${file} names its imports with .js, so NodeNext consumers resolve them`)
}

const user = (text) => ({ role: "user", content: [{ type: "text", text }] })
const reply = (text) => ({ role: "assistant", content: [{ type: "text", text }] })
const call = (id) => ({
  role: "assistant",
  content: [
    { type: "text", text: `step ${id}` },
    { type: "tool_use", id, name: "Bash", input: { command: "ls" } },
  ],
})
const result = (id, size) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(size) }] })

const messages = [user("first"), reply("ok")]
for (let n = 1; n <= 20; n += 1) messages.push(user(`task ${n}`), call(`a${n}`), result(`a${n}`, 3_000), reply(`answer ${n}`))
messages.push(user("the live one"), call("z"), result("z", 20))

const expectedKey = `node-thread-${createHash("sha256").update(JSON.stringify(messages[0].content)).digest("hex").slice(0, 24)}`
assert.equal(threadKeyOf("node-thread", messages), expectedKey, "thread keys hash the same in Node as in Bun")

const store = memoryStore()
const input = { body: { system: "s", tools: [{ name: "Bash" }], messages }, threadId: "node-thread", config: { ...CORE_DEFAULTS, compactAt: 0.1 }, store, window: 100_000, mayCompact: true }
const out = rewrite(input)
assert.equal(out.note.action, "compact")
assert.ok(out.body.messages.length < messages.length)
assert.equal(JSON.stringify(rewrite(input).body), JSON.stringify(out.body), "the same history and state give the same bytes")

const planned = [...messages.slice(0, -3), user("plan it"), reply("PLAN-NODE: two steps"), user("do step one")]
const folded = foldThread({ store, threadId: "node-thread", messages: planned }, { pin: [21] })
assert.deepEqual(folded.pinned, [21])
const afterFold = rewrite({ ...input, body: { ...input.body, messages: planned }, config: { ...CORE_DEFAULTS, mode: "off" } })
assert.equal(afterFold.note.host, true)
assert.match(JSON.stringify(afterFold.body.messages), /PLAN-NODE/)

let asked = 0
await rewriteAsync({ ...input, store: memoryStore() }, async (_query, _chunks, candidates) => {
  asked += 1
  return candidates
})
assert.ok(asked <= 1)

process.stdout.write(`eunoe core runs in Node ${process.version}: ${out.note.action}, ${out.note.messagesIn} → ${out.note.messagesOut} messages, fold at turn ${folded.cutTurn}\n`)
