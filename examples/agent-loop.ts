import { readdirSync } from "node:fs"
import { type Block, CORE_DEFAULTS, foldThread, type Message, memoryStore, rewrite } from "@chroxify/eunoe"

const MODEL = process.env.MODEL ?? "claude-sonnet-5-5"
const UPSTREAM = process.env.UPSTREAM ?? "https://api.anthropic.com"
const WINDOW = 200_000
const PLAN_TURN = 0
const THREAD = "agent-loop"

const store = memoryStore()
const config = { ...CORE_DEFAULTS, mode: "compact" as const }
const tools = [{ name: "list_files", description: "List the files in a folder of the project.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }]
const steps = ["Plan how you would add a CHANGELOG to this project. Reply with the plan only.", "Carry out step one of your plan.", "Carry out the rest of your plan."]

function runTool(block: Block): Block {
  try {
    return { type: "tool_result", tool_use_id: block.id, content: readdirSync(String(block.input?.path ?? ".")).join("\n") }
  } catch (error) {
    return { type: "tool_result", tool_use_id: block.id, content: String(error), is_error: true }
  }
}

async function send(history: Message[]): Promise<{ content: Block[]; stop_reason: string }> {
  const { body, note } = rewrite({ body: { model: MODEL, max_tokens: 4_096, tools, messages: history }, threadId: THREAD, config, store, window: WINDOW, mayCompact: true })
  process.stdout.write(`→ ${note.action}, ${note.messagesIn ?? history.length} → ${body.messages.length} messages\n`)
  const response = await fetch(`${UPSTREAM}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return response.json()
}

const messages: Message[] = []
for (const [index, step] of steps.entries()) {
  messages.push({ role: "user", content: step })
  if (index > 0) foldThread({ store, threadId: THREAD, messages }, { at: "latest", pin: [PLAN_TURN] })
  for (;;) {
    const answer = await send(messages)
    messages.push({ role: "assistant", content: answer.content })
    if (answer.stop_reason !== "tool_use") break
    messages.push({ role: "user", content: answer.content.filter((b) => b.type === "tool_use").map(runTool) })
  }
}
