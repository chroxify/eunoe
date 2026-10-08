import { describe, expect, test } from "bun:test"
import { isSalient, salientLines } from "../src/context/evidence"

const MUST_KEEP: Array<[string, string]> = [
  ["deploy id", "Deployment ID: dpl_qgthe6u4p7"],
  ["preview url", "Preview: https://billing-git-main-chroxify.vercel.app"],
  ["version", "Published eunoe@0.3.1"],
  ["bare semver", "wrangler 3.57.0 (update available 3.58.0)"],
  ["git short hash", "[main 9f3c2ab] feat: rolling default"],
  ["git long hash", "commit 1e1de8ef96f1d22021f594a6d6aeeb94b586aedf"],
  ["sha prefix", "digest: sha256:8a1f0c9e4b2d"],
  ["timestamped migration", "Applied 20250616_shovul in 41ms"],
  ["timestamped name without unit", "Running migration 20250616_add_leases"],
  ["cloud resource id", "Instance i-0a1b2c3d4e5f67890 started"],
  ["pod name", "pod/api-7d9f8b6c5-xk2lp Running"],
  ["request id", "x-request-id: req_01HZY3K7MQ"],
  ["job id", "job 6011 queued"],
  ["port", "listening on http://127.0.0.1:8788"],
  ["duration", "took 412ms"],
  ["size", "Total Upload: 412 KiB"],
  ["percentage", "coverage 87.4%"],
  ["price", "cost $12.40 this month"],
  ["test summary", "Tests: 1 failed, 41 passed"],
  ["test count", "164 passed"],
  ["git stat", "3 files changed, 41 insertions(+), 2 deletions(-)"],
  ["rows", "UPDATE 1203 rows"],
  ["error word", "FAIL src/lease.test.ts"],
  ["error code", "E_ZARRI_6011: lease expired"],
  ["errno", "ENOENT: no such file or directory"],
  ["http status with label", "status: 503 Service Unavailable"],
  ["exit code", "exit code 137"],
  ["signal", "Killed by SIGKILL"],
  ["timeout", "request timed out after 30s"],
  ["denied", "Permission denied (publickey)"],
  ["panic", "panic: runtime error: index out of range"],
  ["traceback", "Traceback (most recent call last):"],
  ["cannot", "cannot find module './foo'"],
  ["flag with value", "started with --port=9000"],
  ["npm scope", "added @chroxify/eunoe"],
  ["p95", "p95 latency 842ms"],
  ["hex id", "trace 8f3a9c2d11e4"],
]

const MUST_DROP = [
  "Uploading 12 files",
  "done",
  "Compiling...",
  "✓ Built in 1.2s".replace("1.2s", "ok"),
  "import { foo } from './bar'",
  "const x = 1",
  "export default function Page() {",
  "  return <div>hello</div>",
  "No changes.",
  "Already up to date.",
  "Switched to branch 'main'",
  "Installing dependencies",
  "// TODO: handle this later",
  "Hello, world",
]

describe("evidence patterns", () => {
  for (const [name, line] of MUST_KEEP) {
    test(`keeps ${name}: ${line}`, () => {
      expect(isSalient(line)).toBe(true)
      expect(salientLines(`noise line\n${line}\nmore noise`)).toContain(line)
    })
  }

  for (const line of MUST_DROP) {
    test(`drops noise: ${line}`, () => {
      expect(isSalient(line)).toBe(false)
    })
  }

  test("a value inside a long noisy output still comes out, ranked above filler", () => {
    const output = [...Array.from({ length: 200 }, (_, i) => `  processing item ${i % 3}`), "Deployment ID: dpl_qgthe6u4p7", ...Array.from({ length: 200 }, () => "waiting")].join("\n")
    expect(salientLines(output)).toEqual(["Deployment ID: dpl_qgthe6u4p7"])
  })

  test("duplicate lines are kept once", () => {
    expect(salientLines("E_ZARRI_6011: lease expired\nE_ZARRI_6011: lease expired")).toHaveLength(1)
  })
})
