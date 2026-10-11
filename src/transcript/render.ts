import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { paths } from "../config/paths"
import { renderIndex, renderMarkdown, renderSubagentMarkdown, renderSubagentXml, renderXml, type SubagentRecord, subagentFile, turnFile } from "./format"
import { parseJsonl, parseTurns, type ToolPart, type TranscriptFormat, type Turn } from "./parse"
import { type SubagentRun, subagentEntries, subagentRuns } from "./subagents"

interface RenderResult {
  dir: string
  changed: boolean
  turns: number
}

export function transcriptDir(sessionId: string) {
  return path.join(paths.transcripts, sessionId)
}

function launchingPart(turns: Turn[], run: SubagentRun): { turn: Turn; part: ToolPart } | null {
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.kind === "tool" && (run.toolUseId ? part.id === run.toolUseId : part.prompt === run.prompt)) return { turn, part }
    }
  }
  return null
}

function subagentRecords(turns: Turn[], runs: SubagentRun[], format: TranscriptFormat): SubagentRecord[] {
  const perTurn = new Map<number, number>()
  return runs.map((run) => {
    const launcher = launchingPart(turns, run)
    const parentTurn = launcher?.turn.number ?? 0
    const k = (perTurn.get(parentTurn) ?? 0) + 1
    perTurn.set(parentTurn, k)
    const file = subagentFile(parentTurn, k, format)
    if (launcher) launcher.part.record = file
    return { run, turns: parseTurns(subagentEntries(run), "any"), parentTurn, file }
  })
}

export function renderTranscript(sessionFile: string, sessionId: string, outDir = transcriptDir(sessionId), format: TranscriptFormat = "markdown"): RenderResult {
  mkdirSync(outDir, { recursive: true })
  const stampFile = path.join(outDir, ".rendered")
  const countFile = path.join(outDir, ".turns")
  const runs = subagentRuns(sessionFile)
  const stamp = [statSync(sessionFile).mtimeMs, ...runs.map((run) => `${run.id}:${run.mtimeMs}`)].join("|")
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) return { dir: outDir, changed: false, turns: Number(readFileSync(countFile, "utf8") || 0) }

  const turns = parseTurns(parseJsonl(readFileSync(sessionFile, "utf8")))
  const records = subagentRecords(turns, runs, format)
  let changed = false
  const write = (file: string, content: string) => {
    const target = path.join(outDir, file)
    if (existsSync(target) && readFileSync(target, "utf8") === content) return
    writeFileSync(target, content)
    changed = true
  }
  for (const turn of turns) write(turnFile(turn, format), format === "xml" ? renderXml(turn) : renderMarkdown(turn))
  for (const record of records) write(record.file, format === "xml" ? renderSubagentXml(record) : renderSubagentMarkdown(record))
  write("index.md", renderIndex(turns, format, records))
  writeFileSync(stampFile, stamp)
  writeFileSync(countFile, String(turns.length))
  return { dir: outDir, changed, turns: turns.length }
}
