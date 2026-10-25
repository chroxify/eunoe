import path from "node:path"
import type { TranscriptFormat } from "./parse"
import { renderTranscript } from "./render"

declare const self: Worker

export interface RenderJob {
  dir: string
  sessionFile: string
  format: TranscriptFormat
}

export interface RenderDone {
  dir: string
  changed: boolean
}

self.onmessage = ({ data }: MessageEvent<RenderJob>) => {
  let changed = false
  try {
    changed = renderTranscript(data.sessionFile, path.basename(data.dir), data.dir, data.format).changed
  } catch {}
  self.postMessage({ dir: data.dir, changed } satisfies RenderDone)
}
