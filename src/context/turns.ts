import { REMINDER_ONLY, SUMMARY_CALLS_SHOWN, SUMMARY_LAST_WORDS_CHARS } from "./constants"
import { blocks, clean, describeToolCall, withoutCacheControl } from "./content"
import { turnEvidence } from "./evidence"
import type { Block, Message, ReduceOptions } from "./types"

export function isPrompt(message: Message) {
  if (message.role !== "user") return false
  const content = blocks(message)
  return !content.some((block) => block.type === "tool_result")
    && content.some((block) => block.type === "text" || block.type === "image" || block.type === "document")
}

export function splitTurns(messages: Message[]): { preamble: Message[]; turns: Message[][] } {
  const preamble: Message[] = []
  const turns: Message[][] = []
  for (const message of messages) {
    if (isPrompt(message) && !(turns.length > 0 && turns.at(-1)!.every((m) => m.role === "user"))) {
      turns.push([message])
    } else if (turns.length > 0) {
      turns.at(-1)!.push(message)
    } else {
      preamble.push(message)
    }
  }
  return { preamble, turns }
}

export function turnFingerprint(turn: Message[]): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(JSON.stringify(blocks(turn[0]).map(withoutCacheControl)))
  return hasher.digest("hex").slice(0, 24)
}

export function isHarness(message: Message) {
  return message.role === "system"
}

export function hasContent(message: Message) {
  return blocks(message).some((block) => block.type !== "text" || String(block.text ?? "").trim())
}

function mergedHarness(turn: Message[]): Message[] {
  const content = turn.filter((m) => isHarness(m) && hasContent(m)).flatMap((m) => blocks(m).map(withoutCacheControl))
  return content.length > 0 ? [{ role: "system", content }] : []
}

function interruptedSummary(turn: Message[]): string {
  const assistant = turn.filter((m) => m.role === "assistant")
  const lastWords = [...assistant].reverse()
    .map((m) => blocks(m).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").trim())
    .find(Boolean)
  const calls = assistant.flatMap((m) => blocks(m).filter((b) => b.type === "tool_use")).map(describeToolCall)
  const shown = calls.slice(-SUMMARY_CALLS_SHOWN)
  return [
    "[This turn was interrupted before a final reply.]",
    lastWords ? `Last thing you said: ${lastWords.length > SUMMARY_LAST_WORDS_CHARS ? `${lastWords.slice(0, SUMMARY_LAST_WORDS_CHARS)}…` : lastWords}` : "",
    calls.length > 0 ? `Tool calls (${calls.length}${calls.length > shown.length ? `, last ${shown.length} shown` : ""}): ${shown.join("; ")}` : "",
    "Their output is in the full transcript.",
  ].filter(Boolean).join("\n")
}

function carriedText(messages: Message[]): Block[] {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) => blocks(m).filter((b) => b.type === "text" && String(b.text ?? "").trim() && !REMINDER_ONLY.test(String(b.text))))
    .map((b) => ({ type: "text", text: b.text }))
}

export function reduceTurn(turn: Message[], options: ReduceOptions = {}): Message[] {
  const opening: Message[] = []
  let i = 0
  for (; i < turn.length && turn[i].role !== "assistant"; i += 1) {
    if (turn[i].role === "user") opening.push(clean(turn[i]))
  }
  const carried = carriedText(turn.slice(i))
  if (carried.length > 0) opening.push({ role: "user", content: carried })
  const evidence = options.evidence ? turnEvidence(turn) : null
  if (evidence) opening.push({ role: "user", content: [{ type: "text", text: evidence }] })
  opening.push(...mergedHarness(turn))
  const last = [...turn].reverse().find((m) => m.role !== "system")!
  const content = last.role === "assistant" ? blocks(last) : []
  const text = content.filter((b) => b.type === "text" && String(b.text ?? "").trim())
  const final = text.length > 0 && !content.some((b) => b.type === "tool_use")
    ? text.map((b) => ({ type: "text", text: b.text }))
    : [{ type: "text", text: interruptedSummary(turn) }]
  return [...opening, { role: "assistant", content: final }]
}
