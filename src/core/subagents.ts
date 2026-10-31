import { blocks, type Message } from "../context/content"
import { splitTurns } from "../context/fold/turns"
import { type RecallChunk, recallChunks } from "../context/recall"

export interface Subagent {
  description: string
  messages: Message[]
  toolUseId?: string
}

const closingTurn: Message = { role: "user", content: "" }

export function launchTurnOf(parentMessages: Message[], toolUseId: string | undefined): number {
  if (!toolUseId) return 0
  const index = splitTurns(parentMessages).turns.findIndex((turn) => turn.some((message) => message.role === "assistant" && blocks(message).some((b) => b.type === "tool_use" && b.id === toolUseId)))
  return index + 1
}

const subagentLabel = (description: string) => `subagent "${description}"`

export function subagentRecall(messages: Message[], description: string, parentTurn: number): RecallChunk[] {
  const from = subagentLabel(description)
  return recallChunks([...messages, closingTurn], new Map()).map((chunk) => ({ ...chunk, from, turn: parentTurn }))
}

export function listSubagentRecall(parentMessages: Message[], subagents: Subagent[]): RecallChunk[] {
  return subagents.flatMap((subagent) => subagentRecall(subagent.messages, subagent.description, launchTurnOf(parentMessages, subagent.toolUseId)))
}
