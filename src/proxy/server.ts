import path from "node:path"
import { claudeConfigDirs, loadConfig, settingsFor } from "../config"
import type { Config } from "../config/types"
import { wellFormed } from "../context/content"
import type { Body } from "../context/types"
import { findSessionFile } from "../transcript/locate"
import { prepareTranscript } from "../transcript/search"
import { VERSION } from "../version"
import { CANONICAL_HEADER, HEALTH_PATH, IDLE_TIMEOUT_SECONDS, LOGGED_ERROR_CHARS, OMITTED_BEFORE_HEADER, OVERFLOW_MARGIN, PROMPT_TOO_LONG, SESSION_HEADER, TRANSCRIPT_HEADER, WINDOW_HEADER } from "./constants"
import { applyCanonical } from "./canonical"
import { sizeOf } from "./estimate"
import { contextFingerprint } from "./fingerprint"
import { logRequest } from "./log"
import { rewriteAsync } from "./rewrite"
import { recordSession } from "./sessions"
import { loadState, saveState } from "./state"
import type { ContextFingerprint, Health, Note } from "./types"
import { inputTokens, watchUsage } from "./usage"
import { resolveWindow } from "./window"

export function sessionIdOf(headers: Headers, body: Body): string | null {
  const header = headers.get(SESSION_HEADER)
  if (header) return header
  try {
    return JSON.parse(body.metadata?.user_id ?? "{}").session_id ?? null
  } catch {
    return null
  }
}

function forwardableHeaders(headers: Headers) {
  const out = new Headers(headers)
  out.delete("content-encoding")
  out.delete("content-length")
  return out
}

const STARTED_AT = Date.now()

export function tooLong(errorText: string): number | null {
  const tokens = Number(errorText.match(PROMPT_TOO_LONG)?.[1])
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null
}

async function prepare(request: Request, body: Body, base: Config, isCountTokens: boolean) {
  const sessionId = sessionIdOf(request.headers, body)
  const config = settingsFor(base, sessionId)
  const trusted = config.eval?.trustHeaders === true
  const transcriptOverride = trusted ? request.headers.get(TRANSCRIPT_HEADER) : null
  const sessionFile = transcriptOverride ?? (sessionId ? findSessionFile(sessionId, claudeConfigDirs(config)) : null)
  if (sessionId && !trusted) recordSession(sessionId, config.mode, sessionFile)
  if (config.mode === "off") return rewriteAsync({ body, sessionId, config, transcript: null, window: null, mayCompact: false })
  const transcript = sessionFile && sessionId
    ? prepareTranscript(config.search, sessionFile, transcriptOverride ? path.basename(transcriptOverride, ".jsonl") : sessionId)
    : null
  const needsWindow = !config.eval?.strategy || config.eval.strategy === "tail"
  const windowOverride = trusted ? Number(request.headers.get(WINDOW_HEADER)) || null : null
  const window = windowOverride ?? config.window ?? (needsWindow ? await resolveWindow(body.model, request.headers, config.upstream) : null)
  return rewriteAsync({
    body,
    sessionId,
    config,
    transcript,
    window,
    mayCompact: !isCountTokens,
    omittedBefore: trusted ? Number(request.headers.get(OMITTED_BEFORE_HEADER) ?? 0) : 0,
  })
}

export async function handle(request: Request): Promise<Response> {
  const config = loadConfig()
  const url = new URL(request.url)
  if (url.pathname === HEALTH_PATH) return Response.json({ ok: true, version: VERSION, mode: config.mode, pid: process.pid, startedAt: STARTED_AT } satisfies Health)
  const headers = new Headers(request.headers)
  headers.delete("host")
  headers.delete("content-length")
  headers.delete("accept-encoding")

  const givenText = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
  let bodyText = givenText
  const isMessages = request.method === "POST" && url.pathname.startsWith("/v1/messages")
  const isCountTokens = url.pathname.includes("count_tokens")
  let note: Note = { action: "pass" }
  let threadKey = null as string | null
  let sentSize = 0
  let givenSize = 0
  let sent = null as (ContextFingerprint & { session: string | null }) | null

  const build = async () => {
    if (!givenText || !isMessages) return
    try {
      const given = JSON.parse(givenText) as Body
      const canonicalFile = config.eval?.trustHeaders ? request.headers.get(CANONICAL_HEADER) : null
      const canonical = canonicalFile ? applyCanonical(given, canonicalFile) : null
      const body = canonical?.body ?? given
      const result = await prepare(request, body, config, isCountTokens)
      note = canonical ? { ...result.note, canonical: canonical.status } : result.note
      threadKey = result.threadKey
      bodyText = result.body !== given ? JSON.stringify(result.body, wellFormed) : givenText
      sentSize = sizeOf(result.body)
      givenSize = result.body === given ? sentSize : sizeOf(given)
      if (config.eval) sent = { session: sessionIdOf(request.headers, given), ...contextFingerprint(result.body), given: contextFingerprint(given) }
    } catch (error) {
      note = { action: "error-passthrough", error: String(error) }
    }
  }
  const send = () => fetch(config.upstream + url.pathname + url.search, { method: request.method, headers, body: bodyText })

  await build()
  let upstream = await send()

  if (upstream.status >= 400 && note.action !== "pass") {
    const errorText = await upstream.text()
    const overflow = tooLong(errorText)
    if (overflow && threadKey && sentSize > 0 && !isCountTokens) {
      const state = loadState(threadKey)
      state.ratio = Math.max(state.ratio ?? 0, overflow / sentSize) * OVERFLOW_MARGIN
      saveState(threadKey, state)
      logRequest({ path: url.pathname, status: upstream.status, thread: threadKey, ...note, overflow, error: errorText.slice(0, LOGGED_ERROR_CHARS) })
      await build()
      note = { ...note, healed: overflow }
      upstream = await send()
    } else {
      logRequest({ path: url.pathname, status: upstream.status, thread: threadKey, ...note, error: errorText.slice(0, LOGGED_ERROR_CHARS) })
      return new Response(errorText, { status: upstream.status, statusText: upstream.statusText, headers: forwardableHeaders(upstream.headers) })
    }
    if (upstream.status >= 400) {
      const retryError = await upstream.text()
      logRequest({ path: url.pathname, status: upstream.status, thread: threadKey, ...note, error: retryError.slice(0, LOGGED_ERROR_CHARS) })
      return new Response(retryError, { status: upstream.status, statusText: upstream.statusText, headers: forwardableHeaders(upstream.headers) })
    }
  }

  const response = new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: forwardableHeaders(upstream.headers) })
  if (note.action === "pass" || !isMessages || isCountTokens) {
    if (note.action !== "pass" || sent) logRequest({ path: url.pathname, status: upstream.status, ...note, ...(sent && { context: sent }) })
    return response
  }

  return watchUsage(response, (usage) => {
    const input = inputTokens(usage)
    logRequest({
      path: url.pathname,
      status: upstream.status,
      thread: threadKey,
      ...note,
      input,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      uncached: usage.input_tokens ?? 0,
      charsIn: givenSize,
      charsOut: sentSize,
      ...(sent && { context: sent }),
    })
    if (threadKey && input > 0 && sentSize > 0) {
      const state = loadState(threadKey)
      state.ratio = input / sentSize
      saveState(threadKey, state)
    }
  })
}

export function serve(port: number) {
  return Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: IDLE_TIMEOUT_SECONDS, fetch: handle })
}
