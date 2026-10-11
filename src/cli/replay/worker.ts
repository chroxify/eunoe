import { statSync } from "node:fs"
import { basename } from "node:path"
import { cwdOf, titleOf } from "../../proxy/sessions"
import { sessionMessages } from "../../transcript/messages"
import { type ReplayedSession, type ReplayOptions, replaySession } from "."

declare var self: Worker

self.onmessage = (event: MessageEvent<{ file: string; options: ReplayOptions }>) => {
  const { file, options } = event.data
  const started = performance.now()
  const replay = replaySession(sessionMessages(file), options)
  const done: ReplayedSession = { ...replay, id: basename(file, ".jsonl"), file, bytes: statSync(file).size, cwd: cwdOf(file) ?? null, title: titleOf(file) ?? null, ms: Math.round(performance.now() - started) }
  postMessage(done)
}
