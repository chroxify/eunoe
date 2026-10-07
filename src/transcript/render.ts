import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { paths } from "../config/constants"
import { INDEX_FILE, RENDER_STAMP, TURN_COUNT_FILE } from "./constants"
import { renderIndex, renderMarkdown, renderXml, turnFile } from "./format"
import { parseTurns } from "./parse"
import type { RenderResult, TranscriptFormat } from "./types"

export function transcriptDir(sessionId: string) {
  return path.join(paths.transcripts, sessionId)
}

export function renderTranscript(sessionFile: string, sessionId: string, outDir = transcriptDir(sessionId), format: TranscriptFormat = "markdown"): RenderResult {
  mkdirSync(outDir, { recursive: true })
  const stampFile = path.join(outDir, RENDER_STAMP)
  const mtime = String(statSync(sessionFile).mtimeMs)
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === mtime) {
    return { dir: outDir, changed: false, turns: Number(readFileSync(path.join(outDir, TURN_COUNT_FILE), "utf8") || 0) }
  }
  const entries = readFileSync(sessionFile, "utf8").split("\n").flatMap((line) => {
    try { return line ? [JSON.parse(line)] : [] } catch { return [] }
  })
  const turns = parseTurns(entries)
  let changed = false
  const write = (file: string, content: string) => {
    const target = path.join(outDir, file)
    if (existsSync(target) && readFileSync(target, "utf8") === content) return
    writeFileSync(target, content)
    changed = true
  }
  for (const turn of turns) write(turnFile(turn, format), format === "xml" ? renderXml(turn) : renderMarkdown(turn))
  write(INDEX_FILE, renderIndex(turns, format))
  writeFileSync(stampFile, mtime)
  writeFileSync(path.join(outDir, TURN_COUNT_FILE), String(turns.length))
  return { dir: outDir, changed, turns: turns.length }
}
