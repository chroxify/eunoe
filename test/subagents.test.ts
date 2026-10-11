import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { peekText } from "../src/cli/sessions"
import { paths } from "../src/config/paths"
import { searchGuide } from "../src/context/prompts"
import { recallFor } from "../src/context/recall"
import { handle } from "../src/proxy/server"
import { renderTranscript } from "../src/transcript/render"
import { prepareTranscript } from "../src/transcript/search"
import { parentTurnOf, subagentChunks, subagentMessages, subagentRuns, subagentsDir } from "../src/transcript/subagents"
import { freshSession } from "./fixtures"

const TOKEN = "tok_zebra_7781"
const PARENT_ONLY = "Current Version ID: 98330153"

const entry = (e: Record<string, unknown>) => JSON.stringify({ cwd: "/repo/sub", timestamp: "2026-10-11T10:00:00Z", ...e })
const userText = (text: string, extra: Record<string, unknown> = {}) => entry({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, ...extra })
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => entry({ type: "assistant", message: { role: "assistant", content }, ...extra })
const toolResult = (id: string, content: string, extra: Record<string, unknown> = {}) => entry({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }, ...extra })

const AGENT_PROMPT = "Deploy the lease service to staging and report the deployment token."
const AGENT_CALL = { type: "tool_use", id: "toolu_agent_1", name: "Agent", input: { description: "Deploy lease service", subagent_type: "general-purpose", prompt: AGENT_PROMPT } }

function parentLines() {
  return [
    userText("deploy to staging and tell me when done"),
    assistant([
      { type: "text", text: "Checking the version first." },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "wrangler versions list" } },
    ]),
    toolResult("t1", PARENT_ONLY),
    assistant([{ type: "text", text: "Handing the deploy to a subagent." }, AGENT_CALL]),
    toolResult("toolu_agent_1", "Deployed the lease service to staging. The token was issued and stored."),
    assistant([{ type: "text", text: "Done: the lease service is on staging." }]),
    userText("thanks, also bump the version in package.json"),
    assistant([{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm version patch" } }]),
    toolResult("t2", "v1.2.4"),
    assistant([{ type: "text", text: "Bumped to 1.2.4." }]),
  ]
}

function subagentLines(agentId: string, sidechain = true) {
  const side = sidechain ? { isSidechain: true, agentId } : {}
  return [
    userText(AGENT_PROMPT, side),
    assistant(
      [
        { type: "text", text: "Deploying." },
        { type: "tool_use", id: "sub_t1", name: "Bash", input: { command: "bun run deploy:staging --service lease" } },
      ],
      side,
    ),
    toolResult("sub_t1", `Deploying lease-service to staging\nDeployment token ${TOKEN} issued for lease-service\nhealth check ok`, side),
    assistant([{ type: "tool_use", id: "sub_t2", name: "Bash", input: { command: "curl -s https://staging.example.com/health" } }], side),
    toolResult("sub_t2", '{"status":"ok","version":"1.2.3"}', side),
    assistant([{ type: "text", text: "Deployed the lease service to staging. The token was issued and stored." }], side),
  ]
}

function writeFolderSession(root: string, id: string) {
  const project = path.join(root, "projects", "-repo-sub")
  mkdirSync(project, { recursive: true })
  const file = path.join(project, `${id}.jsonl`)
  writeFileSync(file, `${parentLines().join("\n")}\n`)
  const dir = subagentsDir(file)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "agent-abc123.jsonl"), `${subagentLines("abc123").join("\n")}\n`)
  writeFileSync(path.join(dir, "agent-abc123.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Deploy lease service", toolUseId: "toolu_agent_1", spawnDepth: 1 }))
  return file
}

function writeInlineSession(root: string, id: string) {
  const project = path.join(root, "projects", "-repo-inline")
  mkdirSync(project, { recursive: true })
  const file = path.join(project, `${id}.jsonl`)
  const lines = parentLines()
  lines.splice(4, 0, ...subagentLines("inline9"))
  writeFileSync(file, `${lines.join("\n")}\n`)
  return file
}

let configDir: string
let folderFile: string
let inlineFile: string

beforeAll(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "eunoe-sub-"))
  folderFile = writeFolderSession(configDir, "folder-session-aaaaaaaa")
  inlineFile = writeInlineSession(configDir, "inline-session-bbbbbbbb")
})

describe("subagent discovery", () => {
  test("finds runs in the session's subagents folder, with the Agent call they came from", () => {
    const runs = subagentRuns(folderFile)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ id: "abc123", inline: false, description: "Deploy lease service", toolUseId: "toolu_agent_1", prompt: AGENT_PROMPT })
    expect(subagentMessages(runs[0])).toHaveLength(6)
  })

  test("finds sidechain entries written into the session file itself, grouped by agent, and links them by prompt", () => {
    const runs = subagentRuns(inlineFile)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ id: "inline9", inline: true, toolUseId: null })
    expect(runs[0].description).toBe(AGENT_PROMPT)
    expect(subagentMessages(runs[0])).toHaveLength(6)
  })

  test("a session without subagents has none, and its own messages never include sidechain entries", () => {
    const project = path.join(configDir, "projects", "-repo-none")
    mkdirSync(project, { recursive: true })
    const file = path.join(project, "none-cccccccc.jsonl")
    writeFileSync(file, `${parentLines().slice(0, 3).join("\n")}\n`)
    expect(subagentRuns(file)).toEqual([])
    expect(subagentChunks(file)).toEqual([])
  })

  test("the parent turn is the one whose Agent call launched the run, in both layouts", () => {
    const { sessionMessages } = require("../src/transcript/messages")
    expect(parentTurnOf(subagentRuns(folderFile)[0], sessionMessages(folderFile))).toBe(1)
    expect(parentTurnOf(subagentRuns(inlineFile)[0], sessionMessages(inlineFile))).toBe(1)
  })
})

describe("subagent transcript", () => {
  test("renders one record per run next to the turn files, cross-linked from the index and the Agent call", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eunoe-sub-render-"))
    const out = renderTranscript(folderFile, "folder-session-aaaaaaaa", dir, "markdown")
    expect(out.turns).toBe(2)
    expect(
      readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort(),
    ).toEqual(["index.md", "turn-0001-subagent-1.md", "turn-0001.md", "turn-0002.md"])
    const record = readFileSync(path.join(dir, "turn-0001-subagent-1.md"), "utf8")
    expect(record).toContain('# Subagent of turn 1 · "Deploy lease service"')
    expect(record).toContain("## Task")
    expect(record).toContain(AGENT_PROMPT)
    expect(record).toContain("### [tool 1/2] Bash: `bun run deploy:staging --service lease`")
    expect(record).toContain(TOKEN)
    expect(record).toContain("## Final reply")
    const turn = readFileSync(path.join(dir, "turn-0001.md"), "utf8")
    expect(turn).toContain("### [tool 2/2] Agent: Deploy lease service")
    expect(turn).toContain("Full record of this subagent run: turn-0001-subagent-1.md")
    expect(turn).not.toContain(TOKEN)
    const index = readFileSync(path.join(dir, "index.md"), "utf8")
    expect(index).toContain("- **turn-0001.md**")
    expect(index).toContain('  - **turn-0001-subagent-1.md**: subagent "Deploy lease service" (2 calls) → Deployed the lease service to staging.')
    expect(index.indexOf("turn-0001-subagent-1.md")).toBeGreaterThan(index.indexOf("- **turn-0001.md**"))
    expect(index.indexOf("turn-0001-subagent-1.md")).toBeLessThan(index.indexOf("- **turn-0002.md**"))
  })

  test("inline sidechain runs render the same way", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eunoe-sub-render-"))
    renderTranscript(inlineFile, "inline-session-bbbbbbbb", dir, "markdown")
    expect(existsSync(path.join(dir, "turn-0001-subagent-1.md"))).toBe(true)
    expect(readFileSync(path.join(dir, "turn-0001-subagent-1.md"), "utf8")).toContain(TOKEN)
    const turn = readFileSync(path.join(dir, "turn-0001.md"), "utf8")
    expect(turn).toContain("Full record of this subagent run: turn-0001-subagent-1.md")
    expect(turn).not.toContain(TOKEN)
  })

  test("xml format gets the record and the link too", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eunoe-sub-render-"))
    renderTranscript(folderFile, "folder-session-aaaaaaaa", dir, "xml")
    const record = readFileSync(path.join(dir, "turn-0001-subagent-1.xml"), "utf8")
    expect(record).toContain('<subagent parent_turn="1" description="Deploy lease service">')
    expect(record).toContain(TOKEN)
    expect(readFileSync(path.join(dir, "turn-0001.xml"), "utf8")).toContain("<record>turn-0001-subagent-1.xml</record>")
  })

  test("a subagent that keeps working re-renders the transcript even though the session file is unchanged", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eunoe-sub-render-"))
    const configDir2 = mkdtempSync(path.join(tmpdir(), "eunoe-sub2-"))
    const file = writeFolderSession(configDir2, "growing-session-dddddddd")
    expect(renderTranscript(file, "growing-session-dddddddd", dir).changed).toBe(true)
    expect(renderTranscript(file, "growing-session-dddddddd", dir).changed).toBe(false)
    const sub = path.join(subagentsDir(file), "agent-abc123.jsonl")
    Bun.sleepSync(5)
    writeFileSync(sub, `${[...subagentLines("abc123"), assistant([{ type: "text", text: "Also rotated the key: key_rotated_42." }], { isSidechain: true, agentId: "abc123" })].join("\n")}\n`)
    expect(renderTranscript(file, "growing-session-dddddddd", dir).changed).toBe(true)
    expect(readFileSync(path.join(dir, "turn-0001-subagent-1.md"), "utf8")).toContain("key_rotated_42")
  })

  test("the search guide tells the agent the subagent files exist", () => {
    const guide = searchGuide({ mode: "markdown", jsonl: folderFile, dir: "/x" })
    expect(guide).toContain("turn-0001-subagent-1.md")
    expect(guide).toContain("subagent")
  })
})

describe("subagent recall", () => {
  test("output only the subagent saw becomes recall chunks labelled with the subagent and its parent turn", () => {
    const chunks = subagentChunks(folderFile)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((c) => c.from === 'subagent "Deploy lease service"' && c.turn === 1)).toBe(true)
    expect(chunks.some((c) => c.lines.join("\n").includes(TOKEN))).toBe(true)
  })

  test("a question about the subagent's output recalls the exact line, labelled", () => {
    const block = recallFor("what deployment token was issued for the lease service", subagentChunks(folderFile))
    expect(block).toContain(TOKEN)
    expect(block).toContain('[subagent "Deploy lease service", turn 1]')
  })

  test("peek on the parent session finds what only the subagent saw", () => {
    const { sessionMessages } = require("../src/transcript/messages")
    const cand = { id: "folder-session-aaaaaaaa", file: folderFile, label: "Deploys", mtime: 0, asks: [], outline: "", messages: sessionMessages(folderFile) }
    const text = peekText(cand, "deployment token lease service")
    expect(text).toContain(TOKEN)
    expect(text).toContain('subagent "Deploy lease service"')
  })

  test("chunks are cached by file and recomputed when the run grows", () => {
    const configDir2 = mkdtempSync(path.join(tmpdir(), "eunoe-sub3-"))
    const file = writeFolderSession(configDir2, "cache-session-eeeeeeee")
    const first = subagentChunks(file)
    expect(first.length).toBeGreaterThan(0)
    expect(subagentChunks(file)[0]).toBe(first[0])
    const sub = path.join(subagentsDir(file), "agent-abc123.jsonl")
    Bun.sleepSync(5)
    writeFileSync(
      sub,
      `${[...subagentLines("abc123"), assistant([{ type: "tool_use", id: "sub_t3", name: "Bash", input: { command: "echo more" } }], { isSidechain: true, agentId: "abc123" }), toolResult("sub_t3", "secret_later_value_77 printed", { isSidechain: true, agentId: "abc123" })].join("\n")}\n`,
    )
    expect(subagentChunks(file).some((c) => c.lines.join("\n").includes("secret_later_value_77"))).toBe(true)
  })
})

describe("end to end through the proxy", () => {
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
  })

  afterAll(() => {
    upstream.stop(true)
    if (savedConfig !== null) writeFileSync(paths.config, savedConfig)
  })

  const parentMessages = (live: string) => [
    { role: "user", content: [{ type: "text", text: "deploy to staging and tell me when done" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Checking the version first." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "wrangler versions list" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: PARENT_ONLY }] },
    { role: "assistant", content: [{ type: "text", text: "Handing the deploy to a subagent." }, AGENT_CALL] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent_1", content: "Deployed the lease service to staging. The token was issued and stored." }] },
    { role: "assistant", content: [{ type: "text", text: "Done: the lease service is on staging." }] },
    { role: "user", content: [{ type: "text", text: live }] },
  ]

  async function ask(sessionId: string, live: string) {
    received.length = 0
    const response = await handle(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test", "x-claude-code-session-id": sessionId },
        body: JSON.stringify({ model: "claude-subagent-test", system: [{ type: "text", text: "You are Claude Code." }], tools: [{ name: "Bash" }, { name: "Agent" }], messages: parentMessages(live) }),
      }),
    )
    await response.text()
    return JSON.parse(received.at(-1)!)
  }

  test("the agent asks about a value only its subagent saw; eunoe recalls it from the subagent's record, labelled, into the live prompt", async () => {
    const sent = await ask("folder-session-aaaaaaaa", "what deployment token was issued for the lease service?")
    const live = JSON.stringify(sent.messages.at(-1))
    expect(live).toContain("<recalled-context>")
    expect(live).toContain(TOKEN)
    expect(live).toContain('subagent \\"Deploy lease service\\", turn 1')
    expect(JSON.stringify(sent.messages.slice(0, -1))).not.toContain(TOKEN)
  })

  test("the same works when the subagent lived inside the session file", async () => {
    const sent = await ask("inline-session-bbbbbbbb", "what deployment token was issued for the lease service?")
    expect(JSON.stringify(sent.messages.at(-1))).toContain(TOKEN)
  })

  test("a question unrelated to the subagent recalls nothing from it", async () => {
    const sent = await ask("folder-session-aaaaaaaa", "please write the changelog entry for the version bump")
    expect(JSON.stringify(sent.messages.at(-1))).not.toContain(TOKEN)
  })

  test("the managed transcript the agent is pointed at has the subagent record", () => {
    const ref = prepareTranscript("markdown", folderFile, "folder-session-aaaaaaaa")
    expect(existsSync(path.join(ref.dir, "turn-0001-subagent-1.md"))).toBe(true)
    expect(readFileSync(path.join(ref.dir, "turn-0001-subagent-1.md"), "utf8")).toContain(TOKEN)
    expect(readFileSync(path.join(ref.dir, "index.md"), "utf8")).toContain("turn-0001-subagent-1.md")
  })

  test("a fresh session with no transcript on disk still works and recalls nothing", async () => {
    const sent = await ask(freshSession(), "what deployment token was issued for the lease service?")
    expect(JSON.stringify(sent.messages.at(-1))).not.toContain(TOKEN)
  })
})
