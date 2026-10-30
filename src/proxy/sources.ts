import { type Config, claudeConfigDirs } from "../config"
import type { Message } from "../context/content"
import { searchGuide } from "../context/prompts"
import type { ThreadSources } from "../core/rewrite"
import { findSessionByPrefix } from "../transcript/locate"
import { sessionMessages } from "../transcript/messages"
import type { TranscriptRef } from "../transcript/search"
import { subagentChunks } from "../transcript/subagents"
import { titleOf } from "./sessions"

function readSession(file: string): Message[] {
  try {
    return sessionMessages(file)
  } catch {
    return []
  }
}

export function sessionSources(transcript: TranscriptRef | null, config: Config, sessionId: string | null): ThreadSources {
  const handoffs = {
    findHandoff: (id: string) => {
      const file = findSessionByPrefix(id, claudeConfigDirs(config), sessionId ?? undefined)
      return file ? { label: titleOf(file) ?? id, source: file } : null
    },
    readHandoff: readSession,
  }
  if (!transcript) return handoffs
  return {
    ...handoffs,
    guide: searchGuide(transcript),
    transcriptDir: transcript.mode !== "jsonl" ? transcript.dir : null,
    readHistory: () => sessionMessages(transcript.jsonl),
    listSubagentChunks: () => subagentChunks(transcript.jsonl),
  }
}
