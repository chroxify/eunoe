import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { blocks, clip, contentBlocks } from "../context/content"
import { splitTurns } from "../context/fold/turns"
import { recallChunks } from "../context/recall"
import type { RecallChunk } from "../context/recall/types"
import type { Message } from "../context/types"
import { AGENT_TOOL_NAMES, SUBAGENT_DESCRIPTION_CHARS, SUBAGENT_FILE_PREFIX, SUBAGENT_INLINE_ID, SUBAGENT_LABEL, SUBAGENTS_DIR } from "./constants"
import { sessionMessages } from "./messages"
import { parseJsonl } from "./parse"
import type { SessionEntry, SubagentRun } from "./types"

const entryCache = new Map<string, { mtimeMs: number; entries: SessionEntry[] }>()
const chunkCache = new Map<string, { mtimeMs: number; parentTurn: number; chunks: RecallChunk[] }>()

function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}

function readEntries(file: string): SessionEntry[] {
  const mtimeMs = mtimeOf(file)
  if (mtimeMs === null) return []
  const hit = entryCache.get(file)
  if (hit?.mtimeMs === mtimeMs) return hit.entries
  const entries = parseJsonl(readFileSync(file, "utf8"))
  entryCache.set(file, { mtimeMs, entries })
  return entries
}

function firstPrompt(entries: SessionEntry[]): string {
  for (const entry of entries) {
    if (entry.type !== "user" || !entry.message) continue
    const text = contentBlocks(entry.message.content)
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

function readMeta(file: string): { description?: string; toolUseId?: string; agentType?: string } {
  try {
    return JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"))
  } catch {
    return {}
  }
}

export function subagentsDir(sessionFile: string) {
  return path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), SUBAGENTS_DIR)
}

export function subagentRuns(sessionFile: string): SubagentRun[] {
  const runs: SubagentRun[] = []
  const dir = subagentsDir(sessionFile)
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(SUBAGENT_FILE_PREFIX) && name.endsWith(".jsonl"))
  } catch {}
  for (const name of names) {
    const file = path.join(dir, name)
    const entries = readEntries(file)
    const meta = readMeta(file)
    const prompt = firstPrompt(entries)
    runs.push({
      id: name.slice(SUBAGENT_FILE_PREFIX.length, -".jsonl".length),
      file,
      inline: false,
      description: meta.description ? String(meta.description) : clip(prompt, SUBAGENT_DESCRIPTION_CHARS),
      toolUseId: meta.toolUseId ? String(meta.toolUseId) : null,
      prompt,
      started: String(entries[0]?.timestamp ?? ""),
      mtimeMs: mtimeOf(file) ?? 0,
    })
  }
  const inline = new Map<string, SessionEntry[]>()
  for (const entry of readEntries(sessionFile)) {
    if (!entry.isSidechain) continue
    const id = entry.agentId ?? SUBAGENT_INLINE_ID
    inline.set(id, [...(inline.get(id) ?? []), entry])
  }
  for (const [id, entries] of inline) {
    if (runs.some((run) => run.id === id)) continue
    const prompt = firstPrompt(entries)
    runs.push({ id, file: sessionFile, inline: true, description: clip(prompt, SUBAGENT_DESCRIPTION_CHARS), toolUseId: null, prompt, started: String(entries[0]?.timestamp ?? ""), mtimeMs: mtimeOf(sessionFile) ?? 0 })
  }
  return runs.sort((a, b) => a.started.localeCompare(b.started))
}

export function subagentEntries(run: SubagentRun): SessionEntry[] {
  const entries = readEntries(run.file)
  if (!run.inline) return entries
  return entries.filter((entry) => entry.isSidechain && (entry.agentId ?? SUBAGENT_INLINE_ID) === run.id)
}

export function subagentMessages(run: SubagentRun): Message[] {
  return subagentEntries(run).flatMap((entry): Message[] => {
    if (entry.isCompactSummary || (entry.type !== "user" && entry.type !== "assistant") || !entry.message) return []
    return [{ role: entry.message.role, content: entry.message.content }]
  })
}

export function parentTurnOf(run: SubagentRun, parentMessages: Message[]): number {
  const { turns } = splitTurns(parentMessages)
  for (const [index, turn] of turns.entries()) {
    for (const message of turn) {
      if (message.role !== "assistant") continue
      for (const block of blocks(message)) {
        if (block.type !== "tool_use") continue
        if (run.toolUseId ? block.id === run.toolUseId : AGENT_TOOL_NAMES.includes(String(block.name)) && String(block.input?.prompt ?? "") === run.prompt) return index + 1
      }
    }
  }
  return 0
}

const subagentLabel = (run: SubagentRun) => `${SUBAGENT_LABEL} "${run.description}"`

export function subagentChunks(sessionFile: string): RecallChunk[] {
  const parent = sessionMessages(sessionFile)
  return subagentRuns(sessionFile).flatMap((run) => {
    const key = `${run.file}#${run.id}`
    const parentTurn = parentTurnOf(run, parent)
    const hit = chunkCache.get(key)
    if (hit && hit.mtimeMs === run.mtimeMs && hit.parentTurn === parentTurn) return hit.chunks
    const chunks = recallChunks([...subagentMessages(run), { role: "user", content: "" }], new Map()).map((chunk) => ({ ...chunk, from: subagentLabel(run), turn: parentTurn }))
    chunkCache.set(key, { mtimeMs: run.mtimeMs, parentTurn, chunks })
    return chunks
  })
}
