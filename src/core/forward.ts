import { type Body, wellFormed } from "../context/content"
import type { Reranker } from "../context/recall"
import { CORE_DEFAULTS, type CoreConfig } from "./config"
import { sizeOf } from "./estimate"
import { type Rewrite, type RewriteNote, rewriteAsync, type ThreadSources } from "./rewrite"
import type { ThreadStore } from "./state"
import { inputTokens, recordOverflow, recordUsage, watchUsage } from "./usage"
import { createWindowLookup, type WindowLookup } from "./window"

export type ForwardNote = RewriteNote | Record<string, unknown>

export type Prepared = Omit<Rewrite, "note"> & { note: ForwardNote }

export interface ForwarderOptions {
  store: ThreadStore
  upstream?: string
  config?: CoreConfig
  window?: number | null | WindowLookup
  threadIdOf?: (request: Request, body: Body) => string | null
  sources?: (threadId: string, request: Request, body: Body) => ThreadSources | undefined
  reranker?: Reranker
  prepare?: (request: Request, body: Body, mayCompact: boolean) => Promise<Prepared>
  record?: (entry: Record<string, unknown>) => void
  countTokensTimeoutMs?: number
}

interface Outgoing {
  note: ForwardNote
  model: unknown
  threadKey: string | null
  bodyText: string | undefined
  sentSize: number
  givenSize: number
  fixedSize: number
}

const COUNT_TOKENS_ATTEMPTS = 3

const DROPPED_REQUEST_HEADERS = ["host", "content-length", "accept-encoding"]

const clipped = (error: string) => error.slice(0, 500)

export function claudeCodeSessionId(headers: Headers, body: Body): string | null {
  const header = headers.get("x-claude-code-session-id")
  if (header) return header
  try {
    return JSON.parse(body.metadata?.user_id ?? "{}").session_id ?? null
  } catch {
    return null
  }
}

const defaultThreadId = (request: Request, body: Body) => request.headers.get("x-thread-id") ?? claudeCodeSessionId(request.headers, body)

function forwardableHeaders(headers: Headers) {
  const out = new Headers(headers)
  out.delete("content-encoding")
  out.delete("content-length")
  return out
}

function defaultPrepare(options: ForwarderOptions, upstream: string): NonNullable<ForwarderOptions["prepare"]> {
  const threadIdOf = options.threadIdOf ?? defaultThreadId
  const given = options.window
  const lookup = typeof given === "function" ? given : createWindowLookup()
  const windowFor: (model: unknown, headers: Headers) => Promise<number | null> = typeof given === "number" || given === null ? () => Promise.resolve(given) : (model, headers) => lookup(model, headers, upstream)
  return async (request, body, mayCompact) => {
    const threadId = threadIdOf(request, body)
    const window = await windowFor(body.model, request.headers)
    const sources = threadId ? options.sources?.(threadId, request, body) : undefined
    return rewriteAsync({ body, threadId, config: options.config ?? CORE_DEFAULTS, store: options.store, sources, window, mayCompact }, options.reranker)
  }
}

const passthrough = (bodyText: string | undefined): Outgoing => ({ note: { action: "pass" }, model: undefined, threadKey: null, bodyText, sentSize: 0, givenSize: 0, fixedSize: 0 })

async function outgoing(prepare: NonNullable<ForwarderOptions["prepare"]>, request: Request, givenText: string, mayCompact: boolean): Promise<Outgoing> {
  try {
    const given = JSON.parse(givenText) as Body
    const result = await prepare(request, given, mayCompact)
    const sentSize = sizeOf(result.body)
    return {
      note: result.note,
      model: given.model,
      threadKey: result.threadKey,
      bodyText: result.body !== given ? JSON.stringify(result.body, wellFormed) : givenText,
      sentSize,
      givenSize: result.body === given ? sentSize : sizeOf(given),
      fixedSize: sizeOf({ ...result.body, messages: [] }),
    }
  } catch (error) {
    return { ...passthrough(givenText), note: { action: "error-passthrough", error: String(error) } }
  }
}

function createSender(request: Request, target: string, headers: Headers, timeout: number | null, stall: { count: number }) {
  return async (body: string | undefined): Promise<Response> => {
    if (timeout === null) return fetch(target, { method: request.method, headers, body })
    for (;;) {
      try {
        return await fetch(target, { method: request.method, headers, body, signal: AbortSignal.timeout(timeout) })
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError"
        if (!timedOut || stall.count + 1 >= COUNT_TOKENS_ATTEMPTS) throw error
        stall.count += 1
      }
    }
  }
}

function delivered(answer: Response, out: Outgoing, metered: boolean, path: string, log: (entry: Record<string, unknown>) => void, store: ThreadStore): Response {
  const { note, threadKey, sentSize, givenSize, fixedSize } = out
  const response = new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: forwardableHeaders(answer.headers) })
  if (note.action === "pass" || !metered) {
    if (note.action !== "pass" || Object.keys(note).length > 1) log({ path, status: answer.status, ...note })
    return response
  }
  return watchUsage(response, (usage) => {
    log({
      path,
      status: answer.status,
      thread: threadKey,
      ...note,
      input: inputTokens(usage),
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      uncached: usage.input_tokens ?? 0,
      charsIn: givenSize,
      charsOut: sentSize,
      charsFixed: fixedSize,
    })
    if (threadKey) recordUsage(store, threadKey, sentSize, usage)
  })
}

export function createForwarder(options: ForwarderOptions): (request: Request) => Promise<Response> {
  const upstream = options.upstream ?? "https://api.anthropic.com"
  const prepare = options.prepare ?? defaultPrepare(options, upstream)
  const timeout = options.countTokensTimeoutMs ?? 10_000

  async function route(request: Request, began: number): Promise<Response> {
    const stall = { count: 0 }
    let prep = 0
    let upload = 0
    const log = (entry: Record<string, unknown>) => options.record?.({ ...entry, ms: Date.now() - began, prep, upload, ...(stall.count > 0 && { stalled: stall.count }) })
    const url = new URL(request.url)
    const headers = new Headers(request.headers)
    for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name)

    let givenText: string | undefined
    if (request.method !== "GET" && request.method !== "HEAD") givenText = await request.text()
    upload = Date.now() - began
    const isMessages = request.method === "POST" && url.pathname.startsWith("/v1/messages")
    const isCountTokens = url.pathname.includes("count_tokens")

    const build = () => (givenText && isMessages ? outgoing(prepare, request, givenText, !isCountTokens) : Promise.resolve(passthrough(givenText)))
    const send = createSender(request, upstream + url.pathname + url.search, headers, isCountTokens ? timeout : null, stall)
    let out = await build()
    prep = Date.now() - began - upload
    let answer = await send(out.bodyText)
    const errorResponse = (text: string) => new Response(text, { status: answer.status, statusText: answer.statusText, headers: forwardableHeaders(answer.headers) })

    if (answer.status >= 400 && out.note.action !== "pass") {
      const errorText = await answer.text()
      const logged = { path: url.pathname, status: answer.status, thread: out.threadKey, ...out.note }
      const overflow = out.threadKey && !isCountTokens ? recordOverflow(options.store, out.threadKey, out.sentSize, errorText, out.model) : null
      if (!overflow) {
        log({ ...logged, error: clipped(errorText) })
        return errorResponse(errorText)
      }
      log({ ...logged, overflow, error: clipped(errorText) })
      out = await build()
      out = { ...out, note: { ...out.note, healed: overflow } }
      answer = await send(out.bodyText)
      if (answer.status >= 400) {
        const retryError = await answer.text()
        log({ path: url.pathname, status: answer.status, thread: out.threadKey, ...out.note, error: clipped(retryError) })
        return errorResponse(retryError)
      }
    }

    return delivered(answer, out, isMessages && !isCountTokens, url.pathname, log, options.store)
  }

  return async (request) => {
    const began = Date.now()
    try {
      return await route(request, began)
    } catch (error) {
      options.record?.({ path: new URL(request.url).pathname, status: 502, action: "upstream-unreachable", error: clipped(String(error)), ms: Date.now() - began })
      return Response.json({ type: "error", error: { type: "api_error", message: `eunoe could not reach the API: ${String(error)}` } }, { status: 502 })
    }
  }
}
