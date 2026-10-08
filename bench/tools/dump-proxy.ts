// A forwarding proxy that records each request's system prompt head, tool
// list shape and message count, then passes it to the API unchanged.
//   bun bench/dump-proxy.ts <port> <logfile>
import { appendFileSync } from "node:fs"

const port = Number(process.argv[2] ?? 8898)
const log = process.argv[3] ?? "/tmp/dump-proxy.jsonl"
const UPSTREAM = "https://api.anthropic.com"

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)
    const raw = req.method === "POST" ? await req.text() : ""
    if (raw) {
      try {
        const b = JSON.parse(raw)
        const sys = Array.isArray(b.system) ? b.system.map((s: any) => s.text ?? "").join("\n") : String(b.system ?? "")
        const bash = (b.tools ?? []).find((t: any) => t.name === "Bash")
        const first = b.messages?.[0]
        const text = (m: any) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((x: any) => x.text ?? `[${x.type}]`).join(" "))
        appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), model: b.model, systemHead: sys.replace(/^x-anthropic-billing-header:[^\n]*\n/, "").slice(0, 90), systemChars: sys.length, tools: (b.tools ?? []).length, bashDescChars: bash ? JSON.stringify(bash).length : 0, messages: b.messages?.length ?? 0, firstMessage: text(first).slice(0, 100) }) + "\n")
      } catch {}
    }
    const headers = new Headers(req.headers)
    headers.delete("host")
    headers.delete("content-length")
    return fetch(`${UPSTREAM}${url.pathname}${url.search}`, { method: req.method, headers, body: raw || undefined })
  },
})
console.log(`dump proxy on ${port} → ${log}`)
