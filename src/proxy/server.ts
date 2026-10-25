import path from "node:path"
import { type Config, claudeConfigDirs, readConfig, settingsFor } from "../config"
import { type Body, wellFormed } from "../context/content"
import { findSessionFile } from "../transcript/locate"
import { prepareTranscript } from "../transcript/search"
import { VERSION } from "../version"
import { applyCanonical } from "./canonical"
import { sizeOf } from "./estimate"
import { type ContextFingerprint, contextFingerprint } from "./fingerprint"
import { logRequest } from "./log"
import { rewriteAsync } from "./rewrite"
import { recordSession } from "./sessions"
import { readState, saveState } from "./state"
import { inputTokens, watchUsage } from "./usage"
import { resolveWindow } from "./window"

export interface Health {
  ok: boolean
  version: string
  mode: Config["mode"]
  pid: number
  startedAt?: number
}

interface Outgoing {
  note: Record<string, unknown>
  threadKey: string | null
  bodyText: string | undefined
  sentSize: number
  givenSize: number
  fixedSize: number
  sent: (ContextFingerprint & { session: string | null }) | null
}

export const HEALTH_PATH = "/_eunoe/health"

const startedAt = Date.now()

const trustedHeader = (request: Request, config: Config, name: string) => (config.eval?.trustHeaders === true ? request.headers.get(`x-eunoe-${name}`) : null)

const clipped = (error: string) => error.slice(0, 500)

function sessionIdOf(headers: Headers, body: Body): string | null {
  const header = headers.get("x-claude-code-session-id")
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

function overflowTokens(errorText: string): number | null {
  const tokens = Number(errorText.match(/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i)?.[1])
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null
}

async function prepare(request: Request, body: Body, base: Config, isCountTokens: boolean) {
  const sessionId = sessionIdOf(request.headers, body)
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

function saveRatio(threadKey: string, ratio: (previous: number | undefined) => number) {
  const state = readState(threadKey)
  state.ratio = ratio(state.ratio)
  saveState(threadKey, state)
}

interface Timing {
  countTokensTimeoutMs: number
}

const COUNT_TOKENS_ATTEMPTS = 3

export async function handle(request: Request, timing: Timing = { countTokensTimeoutMs: 10_000 }): Promise<Response> {
  const began = Date.now()
  try {
    return await route(request, began, timing)
  } catch (error) {
    logRequest({ path: new URL(request.url).pathname, status: 502, action: "upstream-unreachable", error: clipped(String(error)), ms: Date.now() - began })
    return Response.json({ type: "error", error: { type: "api_error", message: `eunoe could not reach the API: ${String(error)}` } }, { status: 502 })
  }
}

async function route(request: Request, began: number, timing: Timing): Promise<Response> {
  let stalled = 0
  let prep = 0
  let upload = 0
  const log = (record: Record<string, unknown>) => logRequest({ ...record, ms: Date.now() - began, prep, upload, ...(stalled > 0 && { stalled }) })
  const config = readConfig()
  const url = new URL(request.url)
  if (url.pathname === HEALTH_PATH) return Response.json({ ok: true, version: VERSION, mode: config.mode, pid: process.pid, startedAt } satisfies Health)
  const headers = new Headers(request.headers)
  for (const name of ["host", "content-length", "accept-encoding"]) headers.delete(name)

  let givenText: string | undefined
  if (request.method !== "GET" && request.method !== "HEAD") givenText = await request.text()
  upload = Date.now() - began
  const isMessages = request.method === "POST" && url.pathname.startsWith("/v1/messages")
  const isCountTokens = url.pathname.includes("count_tokens")

  const build = async (): Promise<Outgoing> => {
    const passthrough: Outgoing = { note: { action: "pass" }, threadKey: null, bodyText: givenText, sentSize: 0, givenSize: 0, fixedSize: 0, sent: null }
    if (!givenText || !isMessages) return passthrough
    try {
      const given = JSON.parse(givenText) as Body
      const canonicalFile = trustedHeader(request, config, "canonical")
      const canonical = canonicalFile ? applyCanonical(given, canonicalFile) : null
      const result = await prepare(request, canonical?.body ?? given, config, isCountTokens)
      const sentSize = sizeOf(result.body)
      return {
        note: canonical ? { ...result.note, canonical: canonical.status } : result.note,
        threadKey: result.threadKey,
        bodyText: result.body !== given ? JSON.stringify(result.body, wellFormed) : givenText,
        sentSize,
        givenSize: result.body === given ? sentSize : sizeOf(given),
        fixedSize: sizeOf({ ...result.body, messages: [] }),
        sent: config.eval ? { session: sessionIdOf(request.headers, given), ...contextFingerprint(result.body), given: contextFingerprint(given) } : null,
      }
    } catch (error) {
      return { ...passthrough, note: { action: "error-passthrough", error: String(error) } }
    }
  }
  const target = config.upstream + url.pathname + url.search
  const send = async (body: string | undefined): Promise<Response> => {
    if (!isCountTokens) return fetch(target, { method: request.method, headers, body })
    for (;;) {
      try {
        return await fetch(target, { method: request.method, headers, body, signal: AbortSignal.timeout(timing.countTokensTimeoutMs) })
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError"
        if (!timedOut || stalled + 1 >= COUNT_TOKENS_ATTEMPTS) throw error
        stalled += 1
      }
    }
  }

  let out = await build()
  prep = Date.now() - began - upload
  let upstream = await send(out.bodyText)
  const errorResponse = (text: string) => new Response(text, { status: upstream.status, statusText: upstream.statusText, headers: forwardableHeaders(upstream.headers) })

  if (upstream.status >= 400 && out.note.action !== "pass") {
    const errorText = await upstream.text()
    const overflow = overflowTokens(errorText)
    const logged = { path: url.pathname, status: upstream.status, thread: out.threadKey, ...out.note }
    if (!overflow || !out.threadKey || out.sentSize === 0 || isCountTokens) {
      log({ ...logged, error: clipped(errorText) })
      return errorResponse(errorText)
    }
    const sentSize = out.sentSize
    saveRatio(out.threadKey, (previous) => Math.max(previous ?? 0, overflow / sentSize) * 1.1)
    log({ ...logged, overflow, error: clipped(errorText) })
    out = await build()
    out = { ...out, note: { ...out.note, healed: overflow } }
    upstream = await send(out.bodyText)
    if (upstream.status >= 400) {
      const retryError = await upstream.text()
      log({ path: url.pathname, status: upstream.status, thread: out.threadKey, ...out.note, error: clipped(retryError) })
      return errorResponse(retryError)
    }
  }

  const { note, threadKey, sentSize, givenSize, fixedSize, sent } = out
  const response = new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: forwardableHeaders(upstream.headers) })
  if (note.action === "pass" || !isMessages || isCountTokens) {
    if (note.action !== "pass" || sent) log({ path: url.pathname, status: upstream.status, ...note, ...(sent && { context: sent }) })
    return response
  }

  return watchUsage(response, (usage) => {
    const input = inputTokens(usage)
    log({
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
      charsFixed: fixedSize,
      ...(sent && { context: sent }),
    })
    if (threadKey && input > 0 && sentSize > 0) saveRatio(threadKey, () => input / sentSize)
  })
}

export function serve(port: number) {
  return Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 255, fetch: (request) => handle(request) })
}
