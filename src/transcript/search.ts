import { existsSync } from "node:fs"
import path from "node:path"
import type { SearchMode } from "../config"
import { renderTranscript, transcriptDir } from "./render"

export interface TranscriptRef {
  mode: SearchMode
  jsonl: string
  dir: string
}

const indexing = new Map<string, Promise<void>>()

async function qmd(cwd: string, args: string[]) {
  await Bun.spawn(["qmd", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exited
}

const isIndexed = (dir: string) => existsSync(path.join(dir, ".qmd"))

function indexWithQmd(dir: string) {
  const next = (indexing.get(dir) ?? Promise.resolve())
    .then(async () => {
      if (!isIndexed(dir)) {
        await qmd(dir, ["init"])
        await qmd(dir, ["collection", "add", ".", "--name", "transcript"])
      }
      await qmd(dir, ["update"])
      await qmd(dir, ["embed"])
    })
    .catch(() => undefined)
  indexing.set(dir, next)
  return next
}

const queued = new Map<string, { mode: SearchMode; sessionFile: string }>()
let draining: Promise<void> | null = null

function renderQueued() {
  for (const [dir, { mode, sessionFile }] of queued) {
    queued.delete(dir)
    try {
      const { changed } = renderTranscript(sessionFile, path.basename(dir), dir, mode === "xml" ? "xml" : "markdown")
      if (mode === "qmd" && (changed || !isIndexed(dir))) void indexWithQmd(dir)
    } catch {}
  }
}

export function flushTranscripts(): Promise<void> {
  return draining ?? Promise.resolve()
}

export function prepareTranscript(mode: SearchMode, sessionFile: string, key: string): TranscriptRef {
  const dir = transcriptDir(key)
  if (mode !== "jsonl") {
    queued.set(dir, { mode, sessionFile })
    draining ??= new Promise<void>((resolve) =>
      setTimeout(() => {
        renderQueued()
        draining = null
        resolve()
      }, 0),
    )
  }
  return { mode, jsonl: sessionFile, dir }
}
