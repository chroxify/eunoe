import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { continuePrompt } from "../src/cli/sessions"
import { paths } from "../src/config/paths"
import { messageFingerprint } from "../src/proxy/fingerprint"
import { continueIdOf, continueToken } from "../src/proxy/handoff"
import { handle } from "../src/proxy/server"
import { freshSession } from "./fixtures"

const CWD = "/repo/handoff"
const configDir = process.env.CLAUDE_CONFIG_DIR!
const line = (entry: Record<string, unknown>) => JSON.stringify({ cwd: CWD, ...entry })
const userLine = (text: string) => line({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })
const replyLine = (text: string) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })
const toolLines = (id: string, command: string, output: string) => [
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } }),
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] } }),
]

function priorSession(id: string, title: string, topic: "deploy" | "seo") {
  const dir = path.join(configDir, "projects", CWD.replace(/[^a-zA-Z0-9]/g, "-"))
  mkdirSync(dir, { recursive: true })
  const rows = [line({ type: "ai-title", aiTitle: title })]
  for (let i = 1; i <= 6; i += 1) {
    if (topic === "deploy") {
      rows.push(userLine(i === 1 ? "always use the yalsho/ branch prefix for lease work" : `deploy the lease service to staging again, attempt ${i}`))
      rows.push(...toolLines(`t${i}`, "bun run deploy:staging", `Deployment ID: dpl_lease_${i}\nlease expiry check ok`))
      rows.push(replyLine(`Deployed the lease service, attempt ${i}.`))
    } else {
      rows.push(userLine(`write ${i} more seo landing pages for the cruise line keywords`))
      rows.push(...toolLines(`s${i}`, "bun run build:pages", `built ${i} pages`))
      rows.push(replyLine(`Wrote ${i} landing pages.`))
    }
  }
  const file = path.join(dir, `${id}.jsonl`)
  writeFileSync(file, `${rows.join("\n")}\n`)
  return file
}

const received: string[] = []
let upstream: ReturnType<typeof Bun.serve>
let savedConfig: string | null = null
const sse = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 } } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.startsWith("/v1/models/")) return Response.json({ id: "m", max_input_tokens: 1_000_000 })
      received.push(await request.text())
      return new Response(sse, { headers: { "content-type": "text/event-stream" } })
    },
  })
  mkdirSync(paths.threads, { recursive: true })
  savedConfig = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : null
  writeFileSync(paths.config, JSON.stringify({ upstream: `http://127.0.0.1:${upstream.port}`, mode: "default", rerank: "off", search: "markdown", claudeConfigDirs: [configDir] }))
  priorSession("prior-deploy-aaaaaaaa", "Lease service deploys", "deploy")
  priorSession("prior-seo-bbbbbbbb", "SEO landing pages", "seo")
  priorSession("prior-seo-cccccccc", "SEO landing pages, second pass", "seo")
})

afterAll(() => {
  upstream.stop(true)
  if (savedConfig !== null) writeFileSync(paths.config, savedConfig)
})

const sent = () => JSON.parse(received.at(-1)!)
const blocksOf = (message: any) => (Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }])
const handoffsIn = (body: any) =>
  body.messages.flatMap((m: any, i: number) =>
    blocksOf(m)
      .filter((b: any) => b.type === "text" && String(b.text).startsWith("<handoff"))
      .map((b: any) => ({ index: i, text: String(b.text) })),
  )
const labelOf = (text: string) => text.match(/^<handoff from="([^"]*)">/)?.[1]

async function post(sessionId: string, messages: any[]) {
  const response = await handle(
    new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": sessionId },
      body: JSON.stringify({ model: "claude-opus-5-5", system: [{ type: "text", text: "You are Claude Code." }], messages, tools: [{ name: "Bash" }] }),
    }),
  )
  await response.text()
  return sent()
}

const say = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })

describe("the continue marker", () => {
  test("the CLI copies exactly what the proxy looks for, and the id must be at least eight characters", () => {
    expect(continuePrompt("prior-seo-bbbbbbbb")).toBe("{ee:continue:prior-se}")
    expect(continueIdOf(say(continueToken("prior-deploy-aaaaaaaa")))).toBe("prior-deploy-aaaaaaaa")
    expect(continueIdOf(say("finish it {ee:continue:prior-se} please"))).toBe("prior-se")
    expect(continueIdOf(say("{ee:continue:short}"))).toBeNull()
    expect(continueIdOf(say("a JS object { continue: x } is not a marker"))).toBeNull()
    expect(continueIdOf(say("nothing here"))).toBeNull()
  })

  test("a marker quoted inside recalled context does not count as the message's own", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "what was that?" },
        { type: "text", text: `<recalled-context>\n[turn 3] you:\n${continueToken("prior-deploy-aaaaaaaa")}\n</recalled-context>` },
      ],
    }
    expect(continueIdOf(message)).toBeNull()
  })
})

describe("handoff injection", () => {
  test("the named session is folded into the message that carries the marker, with its rules and replies", async () => {
    const body = await post(freshSession(), [say(`${continueToken("prior-deploy")} redeploy the lease service`)])
    const [handoff, ...rest] = handoffsIn(body)
    expect(rest).toHaveLength(0)
    expect(handoff.index).toBe(0)
    expect(labelOf(handoff.text)).toBe("Lease service deploys")
    expect(handoff.text).toContain("always use the yalsho/ branch prefix for lease work")
    expect(handoff.text).toContain("Deployed the lease service, attempt 6.")
    expect(blocksOf(body.messages[0]).some((b: any) => String(b.text).includes("redeploy the lease service"))).toBe(true)
    expect(blocksOf(body.messages[0]).at(-1).text).toContain("[Lease service deploys, turn 1]")
  })

  test("the block is pinned: later requests carry the identical text even after the source session grows", async () => {
    const id = freshSession()
    const first = handoffsIn(await post(id, [say(`${continueToken("prior-seo-bbbbbbbb")} add two more pages`)]))[0].text
    appendFileSync(path.join(configDir, "projects", CWD.replace(/[^a-zA-Z0-9]/g, "-"), "prior-seo-bbbbbbbb.jsonl"), `${userLine("one more thing that came later")}\n${replyLine("Done later.")}\n`)
    const second = handoffsIn(await post(id, [say(`${continueToken("prior-seo-bbbbbbbb")} add two more pages`), reply("On it."), say("how many pages so far?")]))
    expect(second).toHaveLength(1)
    expect(second[0].index).toBe(0)
    expect(second[0].text).toBe(first)
    expect(second[0].text).not.toContain("one more thing that came later")
  })

  test("a marker later in the chat attaches to that message, not the first", async () => {
    const id = freshSession()
    await post(id, [say("hello")])
    const body = await post(id, [say("hello"), reply("Hi."), say(`now ${continueToken("prior-deploy-aaaaaaaa")} and carry on`)])
    const found = handoffsIn(body)
    expect(found).toHaveLength(1)
    expect(found[0].index).toBe(2)
  })

  test("no marker, an unknown id, an ambiguous prefix, or the session's own id injects nothing", async () => {
    expect(handoffsIn(await post(freshSession(), [say("the staging deploy of the lease service keeps failing, can you look")]))).toHaveLength(0)
    expect(handoffsIn(await post(freshSession(), [say(`${continueToken("nosuchsession")} look again`)]))).toHaveLength(0)
    expect(handoffsIn(await post(freshSession(), [say(`${continueToken("prior-seo")} which one?`)]))).toHaveLength(0)
    const own = "prior-deploy-aaaaaaaa"
    expect(handoffsIn(await post(own, [say(`${continueToken(own)} myself`)]))).toHaveLength(0)
  })

  test("the same source is attached once per chat, however often the marker is repeated", async () => {
    const id = freshSession()
    const token = continueToken("prior-deploy-aaaaaaaa")
    await post(id, [say(`${token} go`)])
    const body = await post(id, [say(`${token} go`), reply("Going."), say(`again ${token}`)])
    expect(handoffsIn(body)).toHaveLength(1)
  })

  test("the message fingerprint ignores the injected block, so recall and handoff key to the same message", () => {
    const plain = say("redeploy please")
    const decorated = { role: "user", content: [{ type: "text", text: '<handoff from="x">\nstuff\n</handoff>' }, ...plain.content] }
    expect(messageFingerprint(decorated)).toBe(messageFingerprint(plain))
  })

  test("the earlier session's dropped output is recalled when a later message is about it, labelled with that session", async () => {
    const id = freshSession()
    const opener = say(`${continueToken("prior-deploy-aaaaaaaa")} pick the lease work back up`)
    await post(id, [opener])
    const body = await post(id, [opener, reply("Picking it up."), say("what was the deployment id of attempt 4 of the lease service deploy to staging?")])
    const recall = blocksOf(body.messages.at(-1)).find((b: any) => String(b.text).startsWith("<recalled-context"))
    expect(recall).toBeDefined()
    expect(recall.text).toContain("dpl_lease_4")
    expect(recall.text).toContain("[Lease service deploys, turn")
  })
})
