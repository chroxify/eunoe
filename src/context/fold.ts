import { FOLD_REMINDERS } from "./constants"
import { blocks } from "./content"
import { recallChunks, terms } from "./recall"
import { isPrompt, reduceTurn, splitTurns } from "./turns"
import type { Message, RecallChunk } from "./types"

function textOf(message: Message): string {
  return blocks(message).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").replace(FOLD_REMINDERS, "").trim()
}

export interface FoldedTurn {
  user: string
  evidence: string
  reply: string
}

export function foldedTurns(messages: Message[]): FoldedTurn[] {
  const { turns } = splitTurns(messages)
  return turns.filter((turn) => isPrompt(turn[0])).map((turn) => {
    const reduced = reduceTurn(turn, { evidence: true })
    const users = reduced.filter((m) => m.role === "user").map(textOf)
    const evidence = users.filter((t) => t.startsWith("<tool-evidence>")).join("\n")
    const user = users.filter((t) => t && !t.startsWith("<tool-evidence>")).join("\n\n")
    const reply = reduced.filter((m) => m.role === "assistant").map(textOf).join("\n")
    return { user, evidence, reply }
  })
}

function renderTurn(turn: FoldedTurn, index: number, full: boolean): string {
  const parts = [`### Turn ${index + 1}`, `**You:** ${turn.user}`]
  if (full && turn.evidence) parts.push(turn.evidence)
  if (full && turn.reply) parts.push(`**Agent:** ${turn.reply}`)
  return parts.join("\n\n")
}

export function foldedView(messages: Message[], cap = Number.POSITIVE_INFINITY): string {
  const turns = foldedTurns(messages)
  const full = new Set<number>()
  let used = 0
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const size = renderTurn(turns[i], i, true).length
    if (used + size > cap) break
    full.add(i)
    used += size
  }
  return turns.map((turn, i) => renderTurn(turn, i, full.has(i))).join("\n\n")
}

export function sourceChunks(messages: Message[], from: string, users = false): RecallChunk[] {
  const chunks = recallChunks([...messages, { role: "user", content: "" }], new Map()).map((chunk) => ({ ...chunk, from }))
  if (!users) return chunks
  const { turns } = splitTurns(messages)
  const said = turns.filter((turn) => isPrompt(turn[0])).map((turn, i) => ({ turn: i + 1, text: textOf(turn[0]) })).filter((t) => t.text)
  return [...said.map((t) => ({ turn: t.turn, from, call: "you", lines: t.text.split("\n"), terms: terms(t.text) })), ...chunks]
}
