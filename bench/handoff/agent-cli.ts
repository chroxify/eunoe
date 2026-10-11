import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { foldedView, sourceChunks } from "../../src/context/fold"
import { recallFor } from "../../src/context/recall"
import { sessionMessages } from "../../src/transcript/messages"
import { loadMetas } from "../planted/run"
import { INJECT, LOADED, PAGE_CHARS, PEEK_CHARS } from "./constants"
import { sessionFile } from "./prepare"
import { rankSources } from "./run"

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

if (import.meta.main) {
  const ids = (process.env.EUNOE_BENCH_SESSIONS ?? "").split(",").filter(Boolean)
  const metas = loadMetas("all").filter((m) => ids.includes(m.id))
  const [command, ...rest] = process.argv.slice(2)
  const byId = (id: string | undefined) => metas.find((m) => m.id === id) ?? fail(`No session ${id ?? ""}. Run \`eunoe sessions\` to list them.`)
  if (command === "sessions") {
    const words = rest.join(" ").trim()
    const newest = [...metas].sort((a, b) => statSync(sessionFile(b)).mtimeMs - statSync(sessionFile(a)).mtimeMs)
    const order = words ? rankSources(words, newest) : newest
    console.log(words ? `Earlier sessions in this project, closest match first:` : `Earlier sessions in this project, newest first:`)
    for (const m of order) {
      const asks = sessionMessages(sessionFile(m)).filter((x) => x.role === "user" && typeof x.content === "string" && !x.content.startsWith("<"))
      const clip = (x: any) =>
        String(x?.content ?? "")
          .replace(/\s+/g, " ")
          .slice(0, 160)
      console.log(`${m.id}  ${m.title}  (${m.turns} turns, ~${Math.round(m.tokens / 1000)}k tokens)\n      first ask: ${clip(asks[0])}\n      last ask:  ${clip(asks.at(-1))}`)
    }
  } else if (command === "peek") {
    const [id, ...words] = rest
    const meta = byId(id)
    if (words.length === 0) fail("Say what to look for: eunoe peek <id> <words>")
    const chunks = sourceChunks(sessionMessages(sessionFile(meta)), meta.title, true)
    console.log(recallFor(words.join(" "), chunks, { maxChars: PEEK_CHARS, maxCharsMulti: PEEK_CHARS, perQuery: 6, minTerms: 1 }) ?? `Nothing in ${meta.id} matches "${words.join(" ")}".`)
  } else if (command === "load") {
    const pageAt = rest.indexOf("--page")
    const page = pageAt === -1 ? 1 : Number(rest[pageAt + 1])
    const meta = byId(rest.find((a, i) => !a.startsWith("--") && (pageAt === -1 || i !== pageAt + 1)))
    const mode = process.env.EUNOE_BENCH_LOAD ?? "pages"
    if (mode === "brief") {
      console.log(`Handoff brief of session ${meta.id} "${meta.title}":\n`)
      console.log(readFileSync(path.join(INJECT, `${meta.id}.brief-opus.md`), "utf8"))
      process.exit(0)
    }
    const text = foldedView(sessionMessages(sessionFile(meta)))
    if (mode === "file") {
      mkdirSync(LOADED, { recursive: true })
      const file = path.join(LOADED, `${meta.id}.md`)
      writeFileSync(file, text)
      const lines = text.split("\n").length
      console.log(`Session ${meta.id} "${meta.title}" written to ${file} (${lines} lines, ${Math.round(text.length / 1000)}k characters). Read the whole file with the Read tool, from line 1 to line ${lines}, before acting.`)
      process.exit(0)
    }
    const pages = Math.max(1, Math.ceil(text.length / PAGE_CHARS))
    if (!(page >= 1 && page <= pages)) fail(`${meta.id} has pages 1 to ${pages}.`)
    console.log(`Session ${meta.id} "${meta.title}", page ${page} of ${pages}.\n`)
    console.log(text.slice((page - 1) * PAGE_CHARS, page * PAGE_CHARS))
    if (page < pages) console.log(`\n[continued: eunoe load ${meta.id} --page ${page + 1}]`)
  } else {
    fail("Usage: eunoe sessions [words] | eunoe peek <id> <words> | eunoe load <id> [--page N]")
  }
}
