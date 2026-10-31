import path from "node:path"
import { type Config, claudeConfigDirs, readConfig, settingsFor } from "../config"
import type { Body } from "../context/content"
import { contextFingerprint } from "../core/fingerprint"
import { claudeCodeSessionId, createForwarder, type Prepared } from "../core/forward"
import { findSessionFile } from "../transcript/locate"
import { prepareTranscript } from "../transcript/search"
import { VERSION } from "../version"
import { applyCanonical } from "./canonical"
import { logRequest } from "./log"
import { rewriteAsync } from "./rewrite"
import { recordSession } from "./sessions"
import { fileStore } from "./state"
import { resolveWindow } from "./window"

export interface Health {
  ok: boolean
  version: string
  mode: Config["mode"]
  pid: number
  startedAt?: number
}

export const HEALTH_PATH = "/_eunoe/health"

const startedAt = Date.now()

const trustedHeader = (request: Request, config: Config, name: string) => (config.eval?.trustHeaders === true ? request.headers.get(`x-eunoe-${name}`) : null)

async function prepareSession(request: Request, body: Body, base: Config, isCountTokens: boolean) {
  const sessionId = claudeCodeSessionId(request.headers, body)
  const config = settingsFor(base, sessionId)
  const trusted = config.eval?.trustHeaders === true
  const transcriptOverride = trustedHeader(request, config, "transcript")
  const sessionFile = transcriptOverride ?? (sessionId ? findSessionFile(sessionId, claudeConfigDirs(config)) : null)
  if (sessionId && !trusted) recordSession(sessionId, config.mode, sessionFile)
  if (config.mode === "off") return rewriteAsync({ body, sessionId, config, transcript: null, window: null, mayCompact: false })
  const transcriptKey = transcriptOverride ? path.basename(transcriptOverride, ".jsonl") : sessionId
  const transcript = sessionFile && sessionId && transcriptKey ? prepareTranscript(config.search, sessionFile, transcriptKey) : null
  const needsWindow = !config.eval?.strategy || config.eval.strategy === "tail"
  const windowOverride = Number(trustedHeader(request, config, "window")) || null
  let resolved: number | null = null
  if (needsWindow) resolved = await resolveWindow(body.model, request.headers, config.upstream)
  return rewriteAsync({
    body,
    sessionId,
    config,
    transcript,
    window: windowOverride ?? config.window ?? resolved,
    mayCompact: !isCountTokens,
    omittedBefore: Number(trustedHeader(request, config, "omitted-before") ?? 0),
  })
}

async function prepare(request: Request, given: Body, config: Config, mayCompact: boolean): Promise<Prepared> {
  const canonicalFile = trustedHeader(request, config, "canonical")
  const canonical = canonicalFile ? applyCanonical(given, canonicalFile) : null
  const result = await prepareSession(request, canonical?.body ?? given, config, !mayCompact)
  const context = config.eval ? { context: { session: claudeCodeSessionId(request.headers, given), ...contextFingerprint(result.body), given: contextFingerprint(given) } } : {}
  return { ...result, note: { ...result.note, ...(canonical && { canonical: canonical.status }), ...context } }
}

interface Timing {
  countTokensTimeoutMs: number
}

export function handle(request: Request, timing: Timing = { countTokensTimeoutMs: 10_000 }): Promise<Response> {
  const config = readConfig()
  if (new URL(request.url).pathname === HEALTH_PATH) return Promise.resolve(Response.json({ ok: true, version: VERSION, mode: config.mode, pid: process.pid, startedAt } satisfies Health))
  const forward = createForwarder({
    store: fileStore,
    upstream: config.upstream,
    prepare: (incoming, body, mayCompact) => prepare(incoming, body, config, mayCompact),
    record: logRequest,
    countTokensTimeoutMs: timing.countTokensTimeoutMs,
  })
  return forward(request)
}

export function serve(port: number) {
  return Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 255, fetch: (request) => handle(request) })
}
