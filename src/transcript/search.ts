import { existsSync } from "node:fs"
import path from "node:path"
import type { SearchMode } from "../config"
import { transcriptDir } from "./render"
import type { RenderDone, RenderJob } from "./render-worker"

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
let renderer: Worker | null = null
let rendering: { dir: string; mode: SearchMode } | null = null
let drained: Array<() => void> = []

function finished(changed: boolean) {
  if (rendering?.mode === "qmd" && (changed || !isIndexed(rendering.dir))) void indexWithQmd(rendering.dir)
  rendering = null
  renderNext()
}

function startRenderer(): Worker {
  const worker = new Worker(new URL("./render-worker.ts", import.meta.url))
  worker.onmessage = ({ data }: MessageEvent<RenderDone>) => finished(data.changed)
  worker.onerror = () => {
    renderer = null
    finished(false)
  }
  ;(worker as Worker & { unref(): void }).unref()
  return worker
}

function renderNext() {
  const next = queued.entries().next()
  if (next.done) {
    const waiting = drained
    drained = []
    for (const resolve of waiting) resolve()
    return
  }
  const [dir, { mode, sessionFile }] = next.value
  queued.delete(dir)
  rendering = { dir, mode }
  renderer ??= startRenderer()
  renderer.postMessage({ dir, sessionFile, format: mode === "xml" ? "xml" : "markdown" } satisfies RenderJob)
}

export function flushTranscripts(): Promise<void> {
  if (!rendering && queued.size === 0) return Promise.resolve()
  return new Promise((resolve) => drained.push(resolve))
}

export function prepareTranscript(mode: SearchMode, sessionFile: string, key: string): TranscriptRef {
  const dir = transcriptDir(key)
  if (mode !== "jsonl") {
    queued.set(dir, { mode, sessionFile })
    if (!rendering) renderNext()
  }
  return { mode, jsonl: sessionFile, dir }
}
