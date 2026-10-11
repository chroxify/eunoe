import { type Block, blocks, clean, describeToolCall, type Message, shortHash, textOf, withoutCacheControl } from "../content"
import { interruptedReply } from "../prompts"
import { turnEvidence } from "./evidence"

export interface ReduceOptions {
  evidence?: boolean
}

export function isPrompt(message: Message) {
  if (message.role !== "user") return false
  const content = blocks(message)
  return !content.some((block) => block.type === "tool_result") && content.some((block) => block.type === "text" || block.type === "image" || block.type === "document")
}

export function splitTurns(messages: Message[]): { preamble: Message[]; turns: Message[][] } {
  const preamble: Message[] = []
  const turns: Message[][] = []
  for (const message of messages) {
    const current = turns.at(-1)
    if (isPrompt(message) && !current?.every((m) => m.role === "user")) turns.push([message])
    else if (current) current.push(message)
    else preamble.push(message)
  }
  return { preamble, turns }
}

export function turnFingerprint(turn: Message[]): string {
  return shortHash(JSON.stringify(blocks(turn[0]).map(withoutCacheControl)), 24)
}

export function isHarness(message: Message) {
  return message.role === "system"
}

export function hasContent(message: Message) {
  return blocks(message).some((block) => block.type !== "text" || String(block.text ?? "").trim())
}

const hasText = (block: Block) => block.type === "text" && String(block.text ?? "").trim() !== ""

function mergedHarness(turn: Message[]): Message[] {
  const content = turn.filter((m) => isHarness(m) && hasContent(m)).flatMap((m) => blocks(m).map(withoutCacheControl))
  return content.length > 0 ? [{ role: "system", content }] : []
}

function interrupted(turn: Message[]): string {
  const assistant = turn.filter((m) => m.role === "assistant")
  const lastWords = assistant
    .map((m) => textOf(m).trim())
    .filter(Boolean)
    .at(-1)
  const calls = assistant.flatMap((m) => blocks(m).filter((b) => b.type === "tool_use")).map(describeToolCall)
  return interruptedReply(lastWords, calls)
}

function carriedText(messages: Message[]): Block[] {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) => blocks(m).filter((b) => hasText(b) && !/^\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+$/.test(String(b.text))))
    .map((b) => ({ type: "text", text: b.text }))
}

export function reduceTurn(turn: Message[], options: ReduceOptions = {}): Message[] {
  const firstReply = turn.findIndex((m) => m.role === "assistant")
  const opening = (firstReply === -1 ? turn : turn.slice(0, firstReply)).filter((m) => m.role === "user").map(clean)
  const carried = carriedText(firstReply === -1 ? [] : turn.slice(firstReply))
  if (carried.length > 0) opening.push({ role: "user", content: carried })
  const evidence = options.evidence ? turnEvidence(turn) : null
  if (evidence) opening.push({ role: "user", content: [{ type: "text", text: evidence }] })
  opening.push(...mergedHarness(turn))
  const last = turn.findLast((m) => m.role !== "system")
  const content = last?.role === "assistant" ? blocks(last) : []
  const text = content.filter(hasText)
  const final = text.length > 0 && !content.some((b) => b.type === "tool_use") ? text.map((b) => ({ type: "text", text: b.text })) : [{ type: "text", text: interrupted(turn) }]
  return [...opening, { role: "assistant", content: final }]
}
