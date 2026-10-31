import { CORE_DEFAULTS, createForwarder, foldThread, type Message, renderTranscriptFiles, type ThreadState, type ThreadStore } from "@chroxify/eunoe"

interface SyncKv {
  get: (key: string) => unknown
  put: (key: string, value: unknown) => void
  list: (options: { prefix: string }) => Iterable<[string, unknown]>
}

interface ThreadContext {
  storage: { kv: SyncKv }
}

interface Env {
  THREAD: { idFromName: (name: string) => unknown; get: (id: unknown) => { fetch: (request: Request) => Promise<Response> } }
  UPSTREAM?: string
}

interface ThreadRequest {
  messages: Message[]
  at?: number | "latest"
  pin?: number[]
}

const transcriptDir = (threadId: string) => `transcripts/${threadId}`

const threadIdOf = (request: Request) => request.headers.get("x-thread-id") ?? "default"

export class Thread {
  private readonly forward: (request: Request) => Promise<Response>
  private readonly store: ThreadStore

  constructor(
    private readonly ctx: ThreadContext,
    env: Env,
  ) {
    this.store = { read: (key) => (ctx.storage.kv.get(`state:${key}`) as ThreadState | undefined) ?? {}, save: (key, state) => ctx.storage.kv.put(`state:${key}`, state) }
    this.forward = createForwarder({
      store: this.store,
      upstream: env.UPSTREAM,
      config: { ...CORE_DEFAULTS, mode: "compact" },
      window: 15_000,
      threadIdOf,
      sources: (threadId) => ({ guide: `The full transcript is in ${transcriptDir(threadId)}; ask the host to read a turn file from it.`, transcriptDir: transcriptDir(threadId) }),
    })
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/fold") return this.fold(threadIdOf(request), (await request.json()) as ThreadRequest)
    if (path === "/transcript") return this.transcript(threadIdOf(request), (await request.json()) as ThreadRequest)
    if (path === "/state") return Response.json(Object.fromEntries(this.ctx.storage.kv.list({ prefix: "state:" })))
    return this.forward(request)
  }

  private fold(threadId: string, { messages, at, pin }: ThreadRequest): Response {
    return Response.json(foldThread({ store: this.store, threadId, messages }, { at, pin }))
  }

  private transcript(threadId: string, { messages }: ThreadRequest): Response {
    const files = renderTranscriptFiles(messages)
    for (const [name, text] of Object.entries(files)) this.ctx.storage.kv.put(`${transcriptDir(threadId)}/${name}`, text)
    return Response.json({ dir: transcriptDir(threadId), files: Object.keys(files) })
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.THREAD.get(env.THREAD.idFromName(threadIdOf(request))).fetch(request)
  },
}
