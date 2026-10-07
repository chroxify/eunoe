import { DEFAULTS } from "../src/config/constants"
import type { Config } from "../src/config/types"
import type { Message } from "../src/context/types"

export const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
export const system = (text: string): Message => ({ role: "system", content: text })
export const reply = (text: string): Message => ({ role: "assistant", content: [{ type: "thinking", thinking: "…", signature: "s" }, { type: "text", text }] })

export const call = (id: string, input: Record<string, unknown> = { command: "ls" }): Message => ({
  role: "assistant",
  content: [{ type: "text", text: `step ${id}` }, { type: "tool_use", id, name: "Bash", input }],
})

export const result = (id: string, size = 20): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(size) }],
})

export function turn(n: number, options: { done?: boolean; output?: number } = {}): Message[] {
  const { done = true, output = 20 } = options
  return [user(`task ${n}`), call(`a${n}`), result(`a${n}`, output), ...(done ? [reply(`answer ${n}`)] : [])]
}

export function session(count: number, output = 20): Message[] {
  const messages: Message[] = [user("first"), reply("ok")]
  for (let i = 1; i <= count; i += 1) messages.push(...turn(i, { output }))
  messages.push(user("the live one"), call("z"), result("z", output))
  return messages
}

export function config(patch: Partial<Config> = {}): Config {
  return { ...DEFAULTS, search: "jsonl", ...patch }
}

export const transcript = { mode: "jsonl" as const, jsonl: "/t.jsonl", dir: "/t" }

let sessionCounter = 0
export const freshSession = () => `test-session-${++sessionCounter}-${Math.random().toString(36).slice(2)}`
