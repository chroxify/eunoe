import { existsSync, readFileSync } from "node:fs"
import type { Config } from "../config"
import { paths } from "../config/paths"
import type { Reranker } from "../context/recall"
import { jevReranker } from "../context/recall/rerank"
import { type RewriteInput as CoreInput, prefetchRecall as prefetchCore, type Rewrite, rewrite as rewriteCore, rewriteAsync as rewriteCoreAsync } from "../core/rewrite"
import type { TranscriptRef } from "../transcript/search"
import { sessionSources } from "./sources"
import { fileStore } from "./state"

export interface RewriteInput {
  body: CoreInput["body"]
  sessionId: string | null
  config: Config
  transcript: TranscriptRef | null
  window: number | null
  mayCompact: boolean
  omittedBefore?: number
}

export function rerankKey(): string | null {
  const env = process.env.TYPESAFE_API_KEY?.trim()
  if (env) return env
  return existsSync(paths.typesafeKey) ? readFileSync(paths.typesafeKey, "utf8").trim() : null
}

function rerankModel(config: Config): string | null {
  const model = config.eval?.rerank?.model ?? config.rerank
  return model && model !== "off" ? model : null
}

const toCore = ({ sessionId, transcript, ...input }: RewriteInput): CoreInput => ({ ...input, threadId: sessionId, store: fileStore, sources: sessionSources(transcript, input.config, sessionId) })

export const rewrite = (input: RewriteInput): Rewrite => rewriteCore(toCore(input))

export const prefetchRecall = (input: RewriteInput, rerank: Reranker) => prefetchCore(toCore(input), rerank)

export async function rewriteAsync(input: RewriteInput): Promise<Rewrite & { note: { reranked?: string; rerankError?: string } }> {
  const core = toCore(input)
  const model = core.config.mode !== "off" && (core.config.eval?.recall ?? true) ? rerankModel(input.config) : null
  const key = model ? rerankKey() : null
  if (!model || !key) return rewriteCore(core)
  const failure = { reason: null as string | null }
  const reranker = jevReranker(model, key, input.config.eval?.rerank?.endpoint, (reason) => {
    failure.reason = reason
  })
  const result = await rewriteCoreAsync(core, reranker)
  if (result.note.recalled === undefined) return result
  const outcome = failure.reason ? { rerankError: `${model}: ${failure.reason}` } : { reranked: model }
  return { ...result, note: { ...result.note, ...outcome } }
}
