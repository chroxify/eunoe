// Captures what Claude Code sends as system prompt and tools for one point's
// native copy and plain copy, without reaching the API: a dump server answers
// every request with an error and keeps the body. No usage.
//   bun bench/tools/fingerprint-debug.ts p01
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { BASE_SETTINGS, CONFIG_DIR } from "../lib/claude"
import { OUT, choosePoints, repointSummary, shrinkUsage, writeCopy } from "../real/run"

const tag = process.argv[2] ?? "p01"
const DUMP = path.join(OUT, "fingerprint-debug", tag)
mkdirSync(DUMP, { recursive: true })
const listed = JSON.parse(readFileSync(path.join(OUT, "points.json"), "utf8")).find((p: any) => p.tag === tag)
const point = choosePoints().find((p) => p.sessionId === listed.session && p.cutLine === listed.cutLine)!
let current = ""
const server = Bun.serve({
  port: 8899,
  async fetch(req) {
    const body = await req.json().catch(() => ({}))
    writeFileSync(path.join(DUMP, `${current}.system.json`), JSON.stringify(body.system, null, 2))
    writeFileSync(path.join(DUMP, `${current}.tools.json`), JSON.stringify((body.tools ?? []).map((t: any) => ({ name: t.name, len: JSON.stringify(t).length })), null, 2))
    const msgs = body.messages ?? []
    const text = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b.text ?? `[${b.type}]`).join(" ")).slice(0, 160)
    writeFileSync(path.join(DUMP, `${current}.messages.json`), JSON.stringify({ count: msgs.length, chars: JSON.stringify(msgs).length, first: msgs.slice(0, 3).map((m: any) => ({ role: m.role, text: text(m) })), last: msgs.slice(-2).map((m: any) => ({ role: m.role, text: text(m) })) }, null, 2))
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "dump" } }), { status: 400 })
  },
})
const pre = point.lines.slice(0, point.cutLine)
const nativeLines = readFileSync(path.join(OUT, "transcripts", `${tag}.native.jsonl`), "utf8").split("\n").filter(Boolean)
const without = (kind: string) => nativeLines.filter((l) => { try { const e = JSON.parse(l); return e.type !== kind && e.subtype !== kind } catch { return true } })
const repoint = repointSummary(path.join(OUT, "transcripts", `${tag}.jsonl`))
const summaryAt = nativeLines.findIndex((l) => l.includes('"isCompactSummary":true'))
const variants: Array<readonly [string, string[], any]> = process.argv[3] === "bisect"
  ? [["no-boundary", without("compact_boundary"), repoint], ["no-attachment", without("attachment"), repoint], ["no-summary", nativeLines.filter((l) => !l.includes('"isCompactSummary":true')), repoint]]
  : process.argv[3] === "bisect2"
    ? [["pre-repoint", pre, repoint], ["native-shrink", nativeLines, shrinkUsage], ["native-to-summary", nativeLines.slice(0, summaryAt + 1), repoint]]
    : process.argv[3] === "bisect3"
      ? (() => {
          const only = (kind: string) => nativeLines.slice(point.cutLine, summaryAt + 1).filter((l) => { try { const e = JSON.parse(l); return e.type === kind || e.subtype === kind || (kind === "summary" && e.isCompactSummary) } catch { return false } })
          return [["only-boundary", [...pre, ...only("compact_boundary")], repoint], ["only-attachments", [...pre, ...only("attachment")], repoint], ["only-summary", [...pre, ...only("summary")], repoint]] as Array<readonly [string, string[], any]>
        })()
      : process.argv[3] === "bisect4"
        ? (() => {
            const boundary = JSON.parse(nativeLines.slice(point.cutLine, summaryAt + 1).find((l) => l.includes('"compact_boundary"'))!)
            const withB = (patch: (b: any) => any) => [...pre, JSON.stringify(patch(structuredClone(boundary)))]
            return [
              ["boundary-cli", withB((b) => ({ ...b, entrypoint: "cli" })), repoint],
              ["boundary-no-usertype", withB((b) => { delete b.userType; return b }), repoint],
              ["boundary-no-meta", withB((b) => { delete b.compactMetadata; return b }), repoint],
            ] as Array<readonly [string, string[], any]>
          })()
        : process.argv[3] === "rebuilt"
          ? [["native", nativeLines, repoint], ["native-rebuilt", rebuildNative(nativeLines), repoint], ["native-fresh", rebuildNative(nativeLines, true), repoint]]
          : [["native", nativeLines, repoint], ["plain", pre, shrinkUsage]]

function rebuildNative(lines: string[], fresh = false) {
  const entries = lines.map((l) => { try { return JSON.parse(l) } catch { return null } })
  const b = entries.findIndex((e) => e?.subtype === "compact_boundary")
  const keep = new Set<string>(entries[b].compactMetadata?.preservedMessages?.uuids ?? [])
  const out: any[] = []
  let kept = 0
  for (const [i, e] of entries.entries()) {
    if (!e) continue
    if (i < b) { if (keep.has(e.uuid)) { kept += 1; out.push(e) } else if (e.type === "summary" || e.type === "file-history-snapshot") out.push(e); continue }
    if (i === b) continue
    if (fresh && e.isCompactSummary) { delete e.isCompactSummary; delete e.isVisibleInTranscriptOnly }
    out.push(e)
  }
  console.log(`rebuild: ${keep.size} preserved uuids, ${kept} found, fresh=${fresh}`)
  const uuids = new Set(out.map((e) => e.uuid).filter(Boolean))
  for (const e of out) if (e.parentUuid && !uuids.has(e.parentUuid)) e.parentUuid = null
  return out.map((e) => JSON.stringify(e))
}
for (const [name, lines, edit] of variants) {
  current = name
  const id = crypto.randomUUID()
  const file = writeCopy(point, lines, id, edit)
  const proc = Bun.spawn(["claude", "-p", "--output-format", "json", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--resume", id, "--model", "claude-opus-5-5", "--settings", JSON.stringify({ ...BASE_SETTINGS, env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8899" } })], {
    cwd: point.cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR }, stdin: new Blob(["say hi"]), stdout: "pipe", stderr: "pipe",
  })
  await proc.exited
  rmSync(file, { force: true })
  console.log(name, "captured")
}
server.stop()
