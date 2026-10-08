/**
 * Tier 2 of the real-session suite: continuation. Recall is a proxy; this is the thing.
 *
 * For each chosen point the user's real next message is replayed to every
 * arm, which works one turn in its own git worktree of the project, checked
 * out at the last commit before the cut. Outward-facing commands (push,
 * publish, deploy) are denied. Each turn is judged against what the real agent
 * did next, with the standing instructions an oracle extracted from the
 * pre-cut history, and every diff and turn transcript is kept.
 *
 *   bun bench/real/continue.ts [points=20] [parallel=2]
 *
 * Runs after `real/run.ts run`: it reuses the point list, the transcript copies
 * and native's post-compaction session from the recall tier.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { extractJson } from "../lib/json"
import { armSpec } from "../arms"
import { BASE_SETTINGS, NO_TOOLS, claude, projectDir } from "../lib/claude"
import { blocks, clean, parse, realPrompt, textOf, type Entry } from "../lib/points"
import {
  ANSWER_MODEL, ARMS, JUDGES, OUT, PROXIES, choosePoints, proxyFor, proxyRequests, repointSummary, seededShuffle, shrinkUsage, sourceMaterial,
  startProxies, writeCopy, type Arm, type BenchPoint,
} from "./run"

const TOTAL = Number(process.argv[2] ?? 20)
const PARALLEL = Number(process.argv[3] ?? 2)
const WORK = path.join(OUT, "worktrees")
const KEEP = path.join(OUT, "continuation")
const MAX_TURNS = 60
const CONT_ARMS = ARMS.filter((a) => a !== "full")
const TOOLS = "Bash Read Edit Write MultiEdit NotebookEdit Glob Grep WebFetch"
const DENIED = "Bash(git push:*) Bash(gh:*) Bash(npm publish:*) Bash(bun publish:*) Bash(pnpm publish:*) Bash(yarn publish:*) Bash(vercel:*) Bash(wrangler:*) Bash(fly:*) Bash(eas:*) Bash(xcrun altool:*) Bash(xcrun notarytool:*) Bash(fastlane:*) Bash(kubectl:*) Bash(terraform:*) Bash(docker push:*) Bash(curl -X POST:*) Bash(curl --data:*) Agent Task WebSearch"
mkdirSync(KEEP, { recursive: true })
mkdirSync(WORK, { recursive: true })

// ---------------------------------------------------------------- selection

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

// ---------------------------------------------------------------- the real next turn

function nextTurn(point: BenchPoint) {
  const entries = parse(point.lines)
  let promptIndex = -1
  for (let i = point.cutLine; i < entries.length; i += 1) if (realPrompt(entries[i])) { promptIndex = i; break }
  if (promptIndex === -1) return null
  const prompt = clean(textOf(entries[promptIndex]))
  const turn: string[] = []
  const files = new Set<string>()
  for (let i = promptIndex + 1; i < entries.length; i += 1) {
    const e = entries[i]
    if (realPrompt(e)) break
    if (e.isSidechain) continue
    if (e.type === "assistant") {
      for (const b of blocks(e.message)) {
        if (b.type === "text" && String(b.text).trim()) turn.push(`AGENT: ${String(b.text).slice(0, 1500)}`)
        if (b.type === "tool_use") {
          const inp = b.input ?? {}
          if (typeof inp.file_path === "string" && (b.name === "Edit" || b.name === "Write" || b.name === "MultiEdit")) files.add(inp.file_path)
          turn.push(`TOOL ${b.name}: ${String(inp.command ?? inp.file_path ?? inp.pattern ?? JSON.stringify(inp)).replace(/\s+/g, " ").slice(0, 300)}`)
        }
      }
    }
  }
  const stamp = entries[promptIndex].timestamp ?? entries[point.cutLine]?.timestamp
  return { prompt, reference: turn.join("\n").slice(0, 14_000), filesTouched: [...files], timestamp: stamp as string | undefined, branch: entries[promptIndex].gitBranch as string | undefined }
}

// ---------------------------------------------------------------- worktrees

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

// ---------------------------------------------------------------- prompts

const INSTRUCTIONS = (material: string, claudeMd: string) => `Below is the complete history of a coding session up to the moment its context filled, followed by the CLAUDE.md files that applied to it.

List every standing instruction that was still in force at that moment: things the user told the agent to do or not do (commit or not, which package manager, where to deploy, how to write replies, what to leave alone), rules loaded from a skill the agent invoked, and rules from CLAUDE.md. Only instructions a continuing agent could violate in its very next turn. Each as one short line, with its source.

Return only JSON: {"instructions":[{"id":1,"source":"user|skill|claude_md","text":"..."}, ...]}

=== CLAUDE.md ===
${claudeMd.slice(0, 20_000) || "(none)"}

=== SESSION HISTORY ===
${material}`

const JUDGE = (prompt: string, reference: string, instructions: any[], sets: Record<string, string>) => `A coding session was compacted and then continued by several agents. You get the user's next message, what the REAL agent did in response at the time (the reference), the standing instructions active at that moment, and what each agent did on the same message after compaction.

Score each agent:
  "fidelity": 2 = it did what the real continuation did, or something defensibly equivalent given the same instruction · 1 = partly, or headed the right way but stopped short or drifted · 0 = did something else, did nothing useful, or asked the user to repeat what the session already settled
  "violations": the ids of standing instructions it broke in this turn (empty list if none)
  "redundant": how many things it redid that were already complete before the cut — re-reading a file it had already edited, re-running a fixed test, re-asking a settled question (0 if none)
  "why": one line

Judge the work against the user's intent and the reference, not against style. An agent that asks a clarifying question the history already answers is not faithful.

=== USER'S MESSAGE ===
${prompt.slice(0, 4000)}

=== REFERENCE: WHAT THE REAL AGENT DID ===
${reference}

=== STANDING INSTRUCTIONS ===
${instructions.map((i) => `${i.id}. [${i.source}] ${i.text}`).join("\n") || "(none)"}

${Object.entries(sets).map(([label, turn]) => `=== AGENT ${label} ===\n${turn}`).join("\n\n")}

Reply with only JSON: {"grades":{${Object.keys(sets).map((l) => `"${l}":{"fidelity":0,"violations":[],"redundant":0,"why":"..."}`).join(",")}}}`

// ---------------------------------------------------------------- reading a turn back

function turnSummary(file: string, promptText: string, transcriptDirs: string[]) {
  if (!existsSync(file)) return { text: "(no session file)", toolCalls: 0, readsBeforeActing: 0 }
  const entries = parse(readFileSync(file, "utf8").split("\n").filter(Boolean))
  const q = entries.findLastIndex((e) => e.type === "user" && textOf(e).includes(promptText.slice(0, 80)))
  const out: string[] = []
  let toolCalls = 0
  let readsBeforeActing = 0
  let acted = false
  for (const e of entries.slice(q + 1)) {
    if (e.isSidechain) continue
    if (e.type === "assistant") {
      for (const b of blocks(e.message)) {
        if (b.type === "text" && String(b.text).trim()) out.push(`AGENT: ${String(b.text).slice(0, 1500)}`)
        if (b.type === "tool_use") {
          toolCalls += 1
          const inp = b.input ?? {}
          const call = String(inp.command ?? inp.file_path ?? inp.pattern ?? JSON.stringify(inp)).replace(/\s+/g, " ")
          const reads = ["Read", "Grep", "Glob"].includes(b.name) || /^(cat|grep|rg|head|tail|sed -n|ls|find|jq|qmd)\b/.test(String(inp.command ?? ""))
          if (reads && transcriptDirs.some((d) => call.includes(d)) && !acted) readsBeforeActing += 1
          if (!reads) acted = true
          out.push(`TOOL ${b.name}: ${call.slice(0, 300)}`)
        }
      }
    }
  }
  return { text: out.join("\n").slice(0, 14_000), toolCalls, readsBeforeActing }
}

// ---------------------------------------------------------------- one point

async function runPoint(point: ContPoint, index: number) {
  const tag = `c${point.tag.slice(1)}`
  const resultFile = path.join(OUT, `${tag}.json`)
  if (existsSync(resultFile)) return
  const log = (m: string) => console.log(`[${tag} ${point.kind} ${path.basename(point.cwd)}] ${m}`)
  const next = nextTurn(point)
  if (!next) { log("no next turn"); return }
  const pre = point.lines.slice(0, point.cutLine)
  const transcriptCopy = path.join(OUT, "transcripts", `${point.tag}.jsonl`)
  const nativeFile = path.join(OUT, "transcripts", `${point.tag}.native.jsonl`)
  if (!existsSync(transcriptCopy)) { log("recall tier never ran this point"); return }
  let nativeLines: string[]
  if (point.kind === "real") {
    const all = parse(point.lines)
    const firstAfter = all.findIndex((e, i) => i > point.cutLine && e.type === "assistant" && !e.isSidechain)
    nativeLines = point.lines.slice(0, firstAfter === -1 ? point.lines.length : firstAfter)
  } else {
    if (!existsSync(nativeFile)) { log("no native context saved for this synthetic point"); return }
    nativeLines = readFileSync(nativeFile, "utf8").split("\n").filter(Boolean)
  }

  // standing instructions, once per point
  const instructionsFile = path.join(KEEP, `${tag}.instructions.json`)
  let instructions: any[] = []
  if (existsSync(instructionsFile)) instructions = JSON.parse(readFileSync(instructionsFile, "utf8"))
  else {
    const claudeMd = [path.join(point.cwd, "CLAUDE.md"), path.join(homedir(), ".claude", "CLAUDE.md")].filter(existsSync).map((f) => `--- ${f}\n${readFileSync(f, "utf8")}`).join("\n\n")
    const out = await claude(["--model", ANSWER_MODEL, ...NO_TOOLS], { cwd: OUT, stdin: INSTRUCTIONS(sourceMaterial(point), claudeMd) })
    try { instructions = extractJson(out.result).instructions } catch { log("instruction extraction failed; judging without a list") }
    writeFileSync(instructionsFile, JSON.stringify(instructions, null, 2))
  }
  log(`${instructions.length} standing instructions · next message: ${next.prompt.slice(0, 70).replace(/\s+/g, " ")}`)

  const base = commitBefore(point.cwd, next.timestamp, next.branch)
  log(`worktrees at ${base.sha.slice(0, 10)} (${base.ref}${base.flagged ? ", flagged: branch not found" : ""})`)
  const arms: Record<string, any> = {}
  await Promise.all(CONT_ARMS.map(async (arm) => {
    const isNative = arm === "native" || arm === "native+guide"
    const dir = path.join(WORK, `${tag}-${arm.replace("+", "-")}`)
    try { addWorktree(point.cwd, base.sha, dir) } catch (e) { arms[arm] = { error: String(e) }; log(`${arm}: ${e}`); return }
    // Absolute paths in the history point at the real checkout; aim them at the worktree.
    const swap = (s: string) => s.split(point.cwd).join(dir)
    const retarget = (e: Entry) => JSON.parse(swap(JSON.stringify(e)))
    const edit = isNative ? (e: Entry) => retarget(repointSummary(transcriptCopy)(e)) : (e: Entry) => retarget(shrinkUsage(e))
    const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${armSpec(arm).port}`, ANTHROPIC_CUSTOM_HEADERS: `x-eunoe-transcript: ${transcriptCopy}` }
    let id = ""
    let file = ""
    const out = await claude(() => {
      if (file) rmSync(file, { force: true })
      id = crypto.randomUUID()
      file = path.join(projectDir(dir), `${id}.jsonl`)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, (isNative ? nativeLines : pre).map((line) => { try { let e = JSON.parse(line); if (e.sessionId) e.sessionId = id; return JSON.stringify(edit(e)) } catch { return null } }).filter(Boolean).join("\n") + "\n")
      return ["--resume", id, "--model", ANSWER_MODEL, "--permission-mode", "acceptEdits", "--max-turns", String(MAX_TURNS), "--settings", JSON.stringify({ ...BASE_SETTINGS, autoCompactEnabled: false, env }), "--allowedTools", TOOLS, "--disallowedTools", DENIED]
    }, { cwd: dir, stdin: next.prompt, env })
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
  }))

  const answered = CONT_ARMS.filter((a) => arms[a]?.turn)
  const order = seededShuffle(answered, index + 100)
  const labels = order.map((_, i) => String.fromCharCode(65 + i))
  const sets = Object.fromEntries(order.map((arm, i) => [labels[i], `${arms[arm].turn}\n\nFINAL REPLY: ${arms[arm].finalReply}\n\nCHANGED PATHS: ${arms[arm].changedPaths}`]))
  const grades: Record<string, Record<string, any>> = {}
  await Promise.all(JUDGES.map(async (model, j) => {
    await Bun.sleep(j * 1200)
    const out = await claude(["--model", model, ...NO_TOOLS], { cwd: OUT, stdin: JUDGE(next.prompt, next.reference, instructions, sets) })
    try {
      const raw = extractJson(out.result).grades
      grades[model] = Object.fromEntries(order.map((arm, i) => [arm, raw[labels[i]] ?? {}]))
    } catch { log(`judge ${model} failed`) }
  }))
  if (!Object.keys(grades).length) { log("no judge succeeded"); return }
  for (const arm of answered) {
    const judged = JUDGES.filter((m) => grades[m]?.[arm])
    const num = (key: string) => judged.map((m) => Number(key === "violations" ? (grades[m][arm].violations ?? []).length : grades[m][arm][key] ?? 0))
    Object.assign(arms[arm], { fidelity: judged.length ? num("fidelity").reduce((a, b) => a + b, 0) / judged.length : null, violations: judged.length ? num("violations").reduce((a, b) => a + b, 0) / judged.length : null, redundant: judged.length ? num("redundant").reduce((a, b) => a + b, 0) / judged.length : null })
  }
  const result = { tag, point: point.tag, kind: point.kind, cwd: point.cwd, base, prompt: next.prompt, reference: next.reference, instructions, labels: Object.fromEntries(order.map((a, i) => [a, labels[i]])), arms, grades, judges: JUDGES }
  writeFileSync(resultFile, JSON.stringify(result, null, 2))
  log(`fidelity: ${answered.map((a) => `${a} ${arms[a].fidelity?.toFixed(1)}`).join("  ")}`)
}

// ---------------------------------------------------------------- main

if (import.meta.main) {
  const points = chooseContinuation()
  console.log(`continuation: ${points.length} points (${points.filter((p) => p.kind === "real").length} real, ${points.filter((p) => p.kind === "synthetic").length} synthetic) · arms ${CONT_ARMS.join(", ")}`)
  for (const p of points) console.log(`  ${p.tag} ${p.kind.padEnd(9)} ${String(p.afterPrompts).padStart(3)} turns after the cut  ${p.cwd}`)
  const proxies = startProxies()
  await Bun.sleep(1500)
  try {
    let next = 0
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      while (next < points.length) {
        const i = next++
        await runPoint(points[i], i).catch((e) => console.error(`[c${i}]`, e))
      }
    }))
  } finally {
    proxies.forEach((p) => p.kill())
  }
  console.log("done")
}
