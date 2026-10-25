import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { blocks, clip, contentBlocks, type Message } from "../context/content"
import { splitTurns } from "../context/fold/turns"
import { type RecallChunk, recallChunks } from "../context/recall"
import { readSessionEntries } from "./entries"
import { listEntries } from "./locate"
import { sessionMessages } from "./messages"
import { entryMessages, type SessionEntry } from "./parse"

export interface SubagentRun {
  id: string
  file: string
  inline: boolean
  description: string
  toolUseId: string | null
  prompt: string
  started: string
  mtimeMs: number
}

const INLINE_ID = "sidechain"

const runCache = new Map<string, SubagentRun>()
const chunkCache = new Map<string, { mtimeMs: number; parentTurn: number; chunks: RecallChunk[] }>()

function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
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

function readMeta(file: string): { description?: string; toolUseId?: string } {
  try {
    return JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"))
  } catch {
    return {}
  }
}

export function subagentsDir(sessionFile: string) {
  return path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "subagents")
}

function fileRuns(sessionFile: string): SubagentRun[] {
  const dir = subagentsDir(sessionFile)
  return listEntries(dir)
    .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
    .map((name) => {
      const file = path.join(dir, name)
      const mtimeMs = mtimeOf(file) ?? 0
      const known = runCache.get(file)
      if (known?.mtimeMs === mtimeMs) return known
      const entries = readSessionEntries(file)
      const meta = readMeta(file)
      const prompt = firstPrompt(entries)
      const run: SubagentRun = {
        id: name.slice("agent-".length, -".jsonl".length),
        file,
        inline: false,
        description: meta.description ? String(meta.description) : clip(prompt, 80),
        toolUseId: meta.toolUseId ? String(meta.toolUseId) : null,
        prompt,
        started: String(entries[0]?.timestamp ?? ""),
        mtimeMs,
      }
      runCache.set(file, run)
      return run
    })
}

function inlineRuns(sessionFile: string, known: Set<string>): SubagentRun[] {
  const byAgent = new Map<string, SessionEntry[]>()
  for (const entry of readSessionEntries(sessionFile)) {
    if (!entry.isSidechain) continue
    const id = entry.agentId ?? INLINE_ID
    const group = byAgent.get(id)
    if (group) group.push(entry)
    else byAgent.set(id, [entry])
  }
  return [...byAgent]
    .filter(([id]) => !known.has(id))
    .map(([id, entries]) => {
      const prompt = firstPrompt(entries)
      return { id, file: sessionFile, inline: true, description: clip(prompt, 80), toolUseId: null, prompt, started: String(entries[0]?.timestamp ?? ""), mtimeMs: mtimeOf(sessionFile) ?? 0 }
    })
}

export function subagentRuns(sessionFile: string): SubagentRun[] {
  const files = fileRuns(sessionFile)
  const inline = inlineRuns(sessionFile, new Set(files.map((run) => run.id)))
  return [...files, ...inline].sort((a, b) => a.started.localeCompare(b.started))
}

export function subagentEntries(run: SubagentRun): SessionEntry[] {
  const entries = readSessionEntries(run.file)
  if (!run.inline) return entries
  return entries.filter((entry) => entry.isSidechain && (entry.agentId ?? INLINE_ID) === run.id)
}

export function subagentMessages(run: SubagentRun): Message[] {
  return entryMessages(subagentEntries(run))
}

interface Launches {
  byId: Map<unknown, number>
  byPrompt: Map<string, number>
}

function launchesIn(parentMessages: Message[]): Launches {
  const launches: Launches = { byId: new Map(), byPrompt: new Map() }
  splitTurns(parentMessages).turns.forEach((turn, index) => {
    for (const message of turn) {
      if (message.role !== "assistant") continue
      for (const block of blocks(message)) {
        if (block.type !== "tool_use") continue
        if (!launches.byId.has(block.id)) launches.byId.set(block.id, index + 1)
        const prompt = String(block.input?.prompt ?? "")
        if ((block.name === "Agent" || block.name === "Task") && !launches.byPrompt.has(prompt)) launches.byPrompt.set(prompt, index + 1)
      }
    }
  })
  return launches
}

const launchTurn = (run: SubagentRun, launches: Launches) => (run.toolUseId ? launches.byId.get(run.toolUseId) : launches.byPrompt.get(run.prompt)) ?? 0

export function parentTurnOf(run: SubagentRun, parentMessages: Message[]): number {
  return launchTurn(run, launchesIn(parentMessages))
}

const KEPT_LAUNCHES = 8
const launchCache = new Map<Message[], Launches>()

function cachedLaunches(parentMessages: Message[]): Launches {
  const known = launchCache.get(parentMessages)
  if (known) return known
  const launches = launchesIn(parentMessages)
  launchCache.set(parentMessages, launches)
  if (launchCache.size > KEPT_LAUNCHES) launchCache.delete(launchCache.keys().next().value as Message[])
  return launches
}

export function subagentChunks(sessionFile: string): RecallChunk[] {
  const launches = cachedLaunches(sessionMessages(sessionFile))
  return subagentRuns(sessionFile).flatMap((run) => {
    const key = `${run.file}#${run.id}`
    const parentTurn = launchTurn(run, launches)
    const hit = chunkCache.get(key)
    if (hit && hit.mtimeMs === run.mtimeMs && hit.parentTurn === parentTurn) return hit.chunks
    const from = `subagent "${run.description}"`
    const chunks = recallChunks([...subagentMessages(run), { role: "user", content: "" }], new Map()).map((chunk) => ({ ...chunk, from, turn: parentTurn }))
    chunkCache.set(key, { mtimeMs: run.mtimeMs, parentTurn, chunks })
    return chunks
  })
}
