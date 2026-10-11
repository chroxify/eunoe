import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { paths } from "../config/constants"
import { INDEX_FILE, RENDER_STAMP, TURN_COUNT_FILE } from "./constants"
import { renderIndex, renderMarkdown, renderSubagentMarkdown, renderSubagentXml, renderXml, subagentFile, turnFile } from "./format"
import { parseJsonl, parseTurns } from "./parse"
import { subagentEntries, subagentRuns } from "./subagents"
import type { RenderResult, SubagentRecord, SubagentRun, TranscriptFormat } from "./types"

export function transcriptDir(sessionId: string) {
  return path.join(paths.transcripts, sessionId)
}

export function renderTranscript(sessionFile: string, sessionId: string, outDir = transcriptDir(sessionId), format: TranscriptFormat = "markdown"): RenderResult {
  mkdirSync(outDir, { recursive: true })
  const stampFile = path.join(outDir, RENDER_STAMP)
  const runs = subagentRuns(sessionFile)
  const mtime = [statSync(sessionFile).mtimeMs, ...runs.map((run) => `${run.id}:${run.mtimeMs}`)].join("|")
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === mtime) {
    return { dir: outDir, changed: false, turns: Number(readFileSync(path.join(outDir, TURN_COUNT_FILE), "utf8") || 0) }
  }
  const turns = parseTurns(parseJsonl(readFileSync(sessionFile, "utf8")))
  const perTurn = new Map<number, number>()
  const launcher = (run: SubagentRun) => turns.find((turn) => turn.parts.some((p) => p.kind === "tool" && (run.toolUseId ? p.id === run.toolUseId : p.prompt === run.prompt)))
  const records: SubagentRecord[] = runs.map((run) => {
    const parentTurn = launcher(run)?.number ?? 0
    const k = (perTurn.get(parentTurn) ?? 0) + 1
    perTurn.set(parentTurn, k)
    const file = subagentFile(parentTurn, k, format)
    const part = launcher(run)?.parts.find((p) => p.kind === "tool" && (run.toolUseId ? p.id === run.toolUseId : p.prompt === run.prompt))
    if (part && part.kind === "tool") part.record = file
    return { run, turns: parseTurns(subagentEntries(run), "any"), parentTurn, file }
  })
  let changed = false
  const write = (file: string, content: string) => {
    const target = path.join(outDir, file)
    if (existsSync(target) && readFileSync(target, "utf8") === content) return
    writeFileSync(target, content)
    changed = true
  }
  for (const turn of turns) write(turnFile(turn, format), format === "xml" ? renderXml(turn) : renderMarkdown(turn))
  for (const record of records) write(record.file, format === "xml" ? renderSubagentXml(record) : renderSubagentMarkdown(record))
  write(INDEX_FILE, renderIndex(turns, format, records))
  writeFileSync(stampFile, mtime)
  writeFileSync(path.join(outDir, TURN_COUNT_FILE), String(turns.length))
  return { dir: outDir, changed, turns: turns.length }
}
