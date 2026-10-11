import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { armSpec } from "../arms"
import { claude, projectDir } from "../lib/claude"
import { BASE_SETTINGS, NO_TOOLS } from "../lib/constants"
import { extractJson } from "../lib/json"
import { blocks, clean, type Entry, parse, realPrompt, textOf } from "../lib/points"
import { ANSWER_MODEL, CONT_ARMS, CONTINUATION_JUDGE, DENIED, EDIT_TOOLS, INSTRUCTIONS, JUDGES, KEEP, MAX_TURNS, OUT, PROXIES, READ_COMMAND, READ_TOOLS, TOOLS, WORK } from "./constants"
import { type BenchPoint, choosePoints, proxyFor, proxyRequests, repointSummary, seededShuffle, shrinkUsage, sourceMaterial, startProxies } from "./run"

const TOTAL = Number(process.argv[2] ?? 20)
const PARALLEL = Number(process.argv[3] ?? 2)
mkdirSync(KEEP, { recursive: true })
mkdirSync(WORK, { recursive: true })

interface ContPoint extends BenchPoint {
  tag: string
  afterPrompts: number
}

function afterPrompts(point: BenchPoint) {
  return parse(point.lines.slice(point.cutLine)).filter(realPrompt).length
}

function git(cwd: string, args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  return { ok: proc.exitCode === 0, out: new TextDecoder().decode(proc.stdout).trim(), err: new TextDecoder().decode(proc.stderr).trim() }
}

function chooseContinuation(): ContPoint[] {
  const listed = JSON.parse(readFileSync(path.join(OUT, "points.json"), "utf8")) as Array<{ tag: string; session: string; cutLine: number }>
  const all = choosePoints()
  const points: ContPoint[] = []
  for (const row of listed) {
    const p = all.find((x) => x.sessionId === row.session && x.cutLine === row.cutLine)
    if (!p || !existsSync(path.join(OUT, `${row.tag}.json`))) continue
    if (!git(p.cwd, ["rev-parse", "--show-toplevel"]).ok) continue
    const after = afterPrompts(p)
    if (after < 2) continue
    points.push({ ...p, tag: row.tag, afterPrompts: after })
  }
  const richest = (kind: string) => points.filter((p) => p.kind === kind).sort((a, b) => b.afterPrompts - a.afterPrompts)
  const half = Math.ceil(TOTAL / 2)
  const synthetic = richest("synthetic").slice(0, half)
  return [...richest("real").slice(0, TOTAL - synthetic.length), ...synthetic].slice(0, TOTAL).sort((a, b) => a.tag.localeCompare(b.tag))
}

const callOf = (input: Record<string, any>) => String(input.command ?? input.file_path ?? input.pattern ?? JSON.stringify(input)).replace(/\s+/g, " ")

const assistantBlocks = (e: Entry): any[] => (e.type === "assistant" && !e.isSidechain ? blocks(e.message) : [])

function nextTurn(point: BenchPoint) {
  const entries = parse(point.lines)
  const promptIndex = entries.findIndex((e, i) => i >= point.cutLine && realPrompt(e))
  if (promptIndex === -1) return null
  const prompt = clean(textOf(entries[promptIndex]))
  const turn: string[] = []
  const files = new Set<string>()
  for (const e of entries.slice(promptIndex + 1)) {
    if (realPrompt(e)) break
    for (const b of assistantBlocks(e)) {
      if (b.type === "text" && String(b.text).trim()) turn.push(`AGENT: ${String(b.text).slice(0, 1500)}`)
      if (b.type !== "tool_use") continue
      const inp = b.input ?? {}
      if (typeof inp.file_path === "string" && EDIT_TOOLS.includes(b.name)) files.add(inp.file_path)
      turn.push(`TOOL ${b.name}: ${callOf(inp).slice(0, 300)}`)
    }
  }
  const stamp = entries[promptIndex].timestamp ?? entries[point.cutLine]?.timestamp
  return { prompt, reference: turn.join("\n").slice(0, 14_000), filesTouched: [...files], timestamp: stamp as string | undefined, branch: entries[promptIndex].gitBranch as string | undefined }
}

function commitBefore(cwd: string, timestamp: string | undefined, branch: string | undefined) {
  const candidates = [branch, "HEAD"].filter(Boolean) as string[]
  for (const ref of candidates) {
    const r = git(cwd, ["rev-list", "-1", ...(timestamp ? [`--before=${timestamp}`] : []), ref])
    if (r.ok && r.out) return { sha: r.out, ref, flagged: ref === "HEAD" && Boolean(branch) }
  }
  const r = git(cwd, ["rev-parse", "HEAD"])
  return { sha: r.out, ref: "HEAD", flagged: true }
}

function addWorktree(cwd: string, sha: string, dir: string) {
  rmSync(dir, { recursive: true, force: true })
  git(cwd, ["worktree", "prune"])
  const r = git(cwd, ["worktree", "add", "--detach", dir, sha])
  if (!r.ok) throw new Error(`worktree: ${r.err}`)
}

function removeWorktree(cwd: string, dir: string) {
  git(cwd, ["worktree", "remove", "--force", dir])
  rmSync(dir, { recursive: true, force: true })
  git(cwd, ["worktree", "prune"])
}

function diffOf(dir: string) {
  const status = git(dir, ["status", "--porcelain"]).out
  git(dir, ["add", "-A", "--intent-to-add"])
  const diff = git(dir, ["diff"]).out
  return { status, diff: diff.slice(0, 200_000) }
}

function turnSummary(file: string, promptText: string, transcriptDirs: string[]) {
  if (!existsSync(file)) return { text: "(no session file)", toolCalls: 0, readsBeforeActing: 0 }
  const entries = parse(readFileSync(file, "utf8").split("\n").filter(Boolean))
  const q = entries.findLastIndex((e) => e.type === "user" && textOf(e).includes(promptText.slice(0, 80)))
  const out: string[] = []
  let toolCalls = 0
  let readsBeforeActing = 0
  let acted = false
  for (const b of entries.slice(q + 1).flatMap(assistantBlocks)) {
    if (b.type === "text" && String(b.text).trim()) out.push(`AGENT: ${String(b.text).slice(0, 1500)}`)
    if (b.type !== "tool_use") continue
    toolCalls += 1
    const inp = b.input ?? {}
    const call = callOf(inp)
    const reads = READ_TOOLS.includes(b.name) || READ_COMMAND.test(String(inp.command ?? ""))
    if (reads && !acted && transcriptDirs.some((d) => call.includes(d))) readsBeforeActing += 1
    if (!reads) acted = true
    out.push(`TOOL ${b.name}: ${call.slice(0, 300)}`)
  }
  return { text: out.join("\n").slice(0, 14_000), toolCalls, readsBeforeActing }
}

async function runPoint(point: ContPoint, index: number) {
  const tag = `c${point.tag.slice(1)}`
  const resultFile = path.join(OUT, `${tag}.json`)
  if (existsSync(resultFile)) return
  const log = (m: string) => console.log(`[${tag} ${point.kind} ${path.basename(point.cwd)}] ${m}`)
  const next = nextTurn(point)
  if (!next) {
    log("no next turn")
    return
  }
  const pre = point.lines.slice(0, point.cutLine)
  const transcriptCopy = path.join(OUT, "transcripts", `${point.tag}.jsonl`)
  const nativeFile = path.join(OUT, "transcripts", `${point.tag}.native.jsonl`)
  if (!existsSync(transcriptCopy)) {
    log("recall tier never ran this point")
    return
  }
  let nativeLines: string[]
  if (point.kind === "real") {
    const all = parse(point.lines)
    const firstAfter = all.findIndex((e, i) => i > point.cutLine && e.type === "assistant" && !e.isSidechain)
    nativeLines = point.lines.slice(0, firstAfter === -1 ? point.lines.length : firstAfter)
  } else {
    if (!existsSync(nativeFile)) {
      log("no native context saved for this synthetic point")
      return
    }
    nativeLines = readFileSync(nativeFile, "utf8").split("\n").filter(Boolean)
  }

  const instructionsFile = path.join(KEEP, `${tag}.instructions.json`)
  let instructions: any[] = []
  if (existsSync(instructionsFile)) instructions = JSON.parse(readFileSync(instructionsFile, "utf8"))
  else {
    const claudeMd = [path.join(point.cwd, "CLAUDE.md"), path.join(homedir(), ".claude", "CLAUDE.md")]
      .filter(existsSync)
      .map((f) => `--- ${f}\n${readFileSync(f, "utf8")}`)
      .join("\n\n")
    const out = await claude(["--model", ANSWER_MODEL, ...NO_TOOLS], { cwd: OUT, stdin: INSTRUCTIONS(sourceMaterial(point), claudeMd) })
    try {
      instructions = extractJson(out.result).instructions
    } catch {
      log("instruction extraction failed; judging without a list")
    }
    writeFileSync(instructionsFile, JSON.stringify(instructions, null, 2))
  }
  log(`${instructions.length} standing instructions · next message: ${next.prompt.slice(0, 70).replace(/\s+/g, " ")}`)

  const base = commitBefore(point.cwd, next.timestamp, next.branch)
  log(`worktrees at ${base.sha.slice(0, 10)} (${base.ref}${base.flagged ? ", flagged: branch not found" : ""})`)
  const arms: Record<string, any> = {}
  await Promise.all(
    CONT_ARMS.map(async (arm) => {
      const isNative = arm === "native" || arm === "native+guide"
      const dir = path.join(WORK, `${tag}-${arm.replace("+", "-")}`)
      try {
        addWorktree(point.cwd, base.sha, dir)
      } catch (e) {
        arms[arm] = { error: String(e) }
        log(`${arm}: ${e}`)
        return
      }
      const swap = (s: string) => s.split(point.cwd).join(dir)
      const retarget = (e: Entry) => JSON.parse(swap(JSON.stringify(e)))
      const edit = isNative ? (e: Entry) => retarget(repointSummary(transcriptCopy)(e)) : (e: Entry) => retarget(shrinkUsage(e))
      const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${armSpec(arm).port}`, ANTHROPIC_CUSTOM_HEADERS: `x-eunoe-transcript: ${transcriptCopy}` }
      let id = ""
      let file = ""
      const out = await claude(
        () => {
          if (file) rmSync(file, { force: true })
          id = crypto.randomUUID()
          file = path.join(projectDir(dir), `${id}.jsonl`)
          mkdirSync(path.dirname(file), { recursive: true })
          writeFileSync(
            file,
            `${(isNative ? nativeLines : pre)
              .map((line) => {
                try {
                  const e = JSON.parse(line)
                  if (e.sessionId) e.sessionId = id
                  return JSON.stringify(edit(e))
                } catch {
                  return null
                }
              })
              .filter(Boolean)
              .join("\n")}\n`,
          )
          return [
            "--resume",
            id,
            "--model",
            ANSWER_MODEL,
            "--permission-mode",
            "acceptEdits",
            "--max-turns",
            String(MAX_TURNS),
            "--settings",
            JSON.stringify({ ...BASE_SETTINGS, autoCompactEnabled: false, env }),
            "--allowedTools",
            TOOLS,
            "--disallowedTools",
            DENIED,
          ]
        },
        { cwd: dir, stdin: next.prompt, env },
      )
      const proxyDir = path.join(PROXIES, proxyFor(arm))
      const summary = turnSummary(file, next.prompt, [path.join(OUT, "transcripts"), path.join(proxyDir, "transcripts")])
      const { status, diff } = diffOf(dir)
      const requests = proxyRequests(arm, id)
      mkdirSync(path.join(KEEP, tag), { recursive: true })
      writeFileSync(path.join(KEEP, tag, `${arm}.diff`), `# ${status.split("\n").filter(Boolean).length} changed paths\n${status}\n\n${diff}`)
      if (existsSync(file)) writeFileSync(path.join(KEEP, tag, `${arm}.jsonl`), readFileSync(file, "utf8"))
      rmSync(file, { force: true })
      removeWorktree(point.cwd, dir)
      arms[arm] = {
        turn: summary.text,
        finalReply: String(out.result ?? "").slice(0, 3000),
        error: out.is_error ? String(out.result ?? "").slice(0, 300) : undefined,
        wallMs: out.wallMs,
        toolCalls: summary.toolCalls,
        transcriptReadsBeforeActing: summary.readsBeforeActing,
        changedPaths: status.split("\n").filter(Boolean).length,
        tokens: requests.reduce((s, r) => s + (r.input ?? 0), 0),
        cacheRead: requests.reduce((s, r) => s + (r.cacheRead ?? 0), 0),
        contextAtStart: requests.find((r) => r.input)?.input ?? null,
        requests: requests.length,
      }
      log(`${arm}: ${summary.toolCalls} tool calls, ${arms[arm].changedPaths} paths changed, ${Math.round(out.wallMs / 1000)}s${summary.readsBeforeActing ? `, read the transcript first` : ""}`)
    }),
  )

  const answered = CONT_ARMS.filter((a) => arms[a]?.turn)
  const order = seededShuffle(answered, index + 100)
  const labels = order.map((_, i) => String.fromCharCode(65 + i))
  const sets = Object.fromEntries(order.map((arm, i) => [labels[i], `${arms[arm].turn}\n\nFINAL REPLY: ${arms[arm].finalReply}\n\nCHANGED PATHS: ${arms[arm].changedPaths}`]))
  const grades: Record<string, Record<string, any>> = {}
  await Promise.all(
    JUDGES.map(async (model, j) => {
      await Bun.sleep(j * 1200)
      const out = await claude(["--model", model, ...NO_TOOLS], { cwd: OUT, stdin: CONTINUATION_JUDGE(next.prompt, next.reference, instructions, sets) })
      try {
        const raw = extractJson(out.result).grades
        grades[model] = Object.fromEntries(order.map((arm, i) => [arm, raw[labels[i]] ?? {}]))
      } catch {
        log(`judge ${model} failed`)
      }
    }),
  )
  if (Object.keys(grades).length === 0) {
    log("no judge succeeded")
    return
  }
  for (const arm of answered) {
    const judged = JUDGES.filter((m) => grades[m]?.[arm])
    const num = (key: string) => judged.map((m) => Number(key === "violations" ? (grades[m][arm].violations ?? []).length : (grades[m][arm][key] ?? 0)))
    Object.assign(arms[arm], {
      fidelity: judged.length > 0 ? num("fidelity").reduce((a, b) => a + b, 0) / judged.length : null,
      violations: judged.length > 0 ? num("violations").reduce((a, b) => a + b, 0) / judged.length : null,
      redundant: judged.length > 0 ? num("redundant").reduce((a, b) => a + b, 0) / judged.length : null,
    })
  }
  const result = { tag, point: point.tag, kind: point.kind, cwd: point.cwd, base, prompt: next.prompt, reference: next.reference, instructions, labels: Object.fromEntries(order.map((a, i) => [a, labels[i]])), arms, grades, judges: JUDGES }
  writeFileSync(resultFile, JSON.stringify(result, null, 2))
  log(`fidelity: ${answered.map((a) => `${a} ${arms[a].fidelity?.toFixed(1)}`).join("  ")}`)
}

if (import.meta.main) {
  const points = chooseContinuation()
  console.log(`continuation: ${points.length} points (${points.filter((p) => p.kind === "real").length} real, ${points.filter((p) => p.kind === "synthetic").length} synthetic) · arms ${CONT_ARMS.join(", ")}`)
  for (const p of points) console.log(`  ${p.tag} ${p.kind.padEnd(9)} ${String(p.afterPrompts).padStart(3)} turns after the cut  ${p.cwd}`)
  const proxies = startProxies()
  await Bun.sleep(1500)
  try {
    let next = 0
    await Promise.all(
      Array.from({ length: PARALLEL }, async () => {
        while (next < points.length) {
          const i = next++
          await runPoint(points[i], i).catch((e) => console.error(`[c${i}]`, e))
        }
      }),
    )
  } finally {
    for (const p of proxies) p.kill()
  }
  console.log("done")
}
