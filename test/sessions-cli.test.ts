import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { load, loadedLine, writeLoaded } from "../src/cli/commands/load"
import { candidateOf, continuePrompt } from "../src/cli/sessions"
import { rankCandidates, sessionCandidates } from "../src/cli/sessions/source"
import { paths } from "../src/config/constants"
import { recordSession } from "../src/proxy/sessions"

const CWD = "/repo/sessions-cli"
const line = (entry: Record<string, unknown>, cwd: string) => JSON.stringify({ cwd, ...entry })
const userLine = (text: string, cwd: string) => line({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }, cwd)
const replyLine = (text: string, cwd: string) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }, cwd)
const toolLines = (id: string, command: string, output: string, cwd: string) => [
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } }, cwd),
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] } }, cwd),
]

function priorSession(id: string, cwd: string, title: string, topic: "deploy" | "seo") {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
  mkdirSync(dir, { recursive: true })
  const rows = [line({ type: "ai-title", aiTitle: title }, cwd)]
  for (let i = 1; i <= 6; i += 1) {
    if (topic === "deploy") {
      rows.push(userLine(i === 1 ? "always use the yalsho/ branch prefix for lease work" : `deploy the lease service to staging again, attempt ${i}`, cwd))
      rows.push(...toolLines(`t${i}`, "bun run deploy:staging", `Deployment ID: dpl_lease_${i}\nlease expiry check ok`, cwd))
      rows.push(replyLine(`Deployed the lease service, attempt ${i}.`, cwd))
    } else {
      rows.push(userLine(`write ${i} more seo landing pages for the cruise line keywords`, cwd))
      rows.push(...toolLines(`s${i}`, "bun run build:pages", `built ${i} pages`, cwd))
      rows.push(replyLine(`Wrote ${i} landing pages.`, cwd))
    }
  }
  const file = path.join(dir, `${id}.jsonl`)
  writeFileSync(file, `${rows.join("\n")}\n`)
  recordSession(id, "default", file)
  return file
}

const configDirs = () => [process.env.CLAUDE_CONFIG_DIR!]
const originalCwd = process.cwd
const logged: string[] = []

beforeAll(async () => {
  priorSession("prior-deploy-aaaaaaaa", CWD, "Lease service deploys", "deploy")
  await Bun.sleep(20)
  priorSession("prior-seo-bbbbbbbb", CWD, "SEO landing pages", "seo")
  priorSession("prior-other-cccccccc", "/repo/elsewhere", "Other repo deploys", "deploy")
  process.cwd = () => CWD
  spyOn(console, "log").mockImplementation((text: string) => {
    logged.push(text)
  })
})

afterAll(() => {
  process.cwd = originalCwd
})

describe("session lookup", () => {
  test("finds this directory's sessions newest first, with their asks, and none from elsewhere", () => {
    const found = sessionCandidates("", CWD, configDirs())
    expect(found.map((c) => c.id)).toEqual(["prior-seo-bbbbbbbb", "prior-deploy-aaaaaaaa"])
    expect(found[1].label).toBe("Lease service deploys")
    expect(found[1].asks).toHaveLength(6)
    expect(found[1].asks[0]).toBe("always use the yalsho/ branch prefix for lease work")
    expect(found[1].asks.at(-1)).toBe("deploy the lease service to staging again, attempt 6")
  })

  test("words put the matching session first", () => {
    const found = sessionCandidates("", CWD, configDirs())
    expect(rankCandidates("the staging deploy of the lease service keeps failing", found)[0].id).toBe("prior-deploy-aaaaaaaa")
    expect(rankCandidates("two more landing pages for the cruise keywords", found)[0].id).toBe("prior-seo-bbbbbbbb")
  })

  test("an id resolves exactly or by unique prefix", () => {
    const found = sessionCandidates("", CWD, configDirs())
    expect(candidateOf("prior-seo-bbbbbbbb", found).id).toBe("prior-seo-bbbbbbbb")
    expect(candidateOf("prior-dep", found).id).toBe("prior-deploy-aaaaaaaa")
  })
})

describe("load", () => {
  test("writes the whole folded session to a file and says how to read it", async () => {
    const cand = sessionCandidates("", CWD, configDirs()).find((c) => c.id === "prior-deploy-aaaaaaaa")!
    const written = writeLoaded(cand)
    expect(written.file).toBe(path.join(paths.loaded, "prior-deploy-aaaaaaaa.md"))
    const text = readFileSync(written.file, "utf8")
    expect(text).toContain("yalsho/")
    expect(text).toContain("Deployed the lease service, attempt 6.")
    expect(text.split("\n")).toHaveLength(written.lines)
    expect(loadedLine(cand, written)).toBe(
      `Session prior-de "Lease service deploys" written to ${written.file} (${written.lines} lines, ${Math.round(written.chars / 1000)}k characters). Read the whole file with the Read tool, from line 1 to line ${written.lines}, before acting.`,
    )
    logged.length = 0
    await load.run(["prior-dep"])
    expect(logged).toEqual([loadedLine(cand, written)])
    expect(existsSync(written.file)).toBe(true)
  })

  test("the prompt eunoe sessions copies names the session to load", () => {
    expect(continuePrompt("prior-seo-bbbbbbbb")).toBe("{ee:continue:prior-se}")
  })
})
