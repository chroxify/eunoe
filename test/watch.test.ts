import { describe, expect, test } from "bun:test"
import { nextWatch, WATCH_MISSES } from "../src/cli/proxy/watch"

const now = "2026-10-11T10:00:00.000Z"
const dirs = ["/home/me/.claude"]

describe("proxy watchdog", () => {
  test("a single missed probe is forgiven", () => {
    const step = nextWatch({ misses: 0, paused: [] }, false, dirs, now)
    expect(step).toEqual({ watch: { misses: 1, paused: [] }, pause: [], resume: [] })
  })

  test("after enough misses the routed dirs are unrouted and remembered", () => {
    const step = nextWatch({ misses: WATCH_MISSES - 1, paused: [] }, false, dirs, now)
    expect(step.pause).toEqual(dirs)
    expect(step.watch).toEqual({ misses: 0, paused: dirs, pausedAt: now })
  })

  test("a healthy proxy restores exactly what was paused and resets", () => {
    const step = nextWatch({ misses: 0, paused: dirs, pausedAt: now }, true, [], now)
    expect(step).toEqual({ watch: { misses: 0, paused: [] }, pause: [], resume: dirs })
  })

  test("a dead proxy with nothing routed is not an outage", () => {
    const step = nextWatch({ misses: 1, paused: [] }, false, [], now)
    expect(step).toEqual({ watch: { misses: 0, paused: [] }, pause: [], resume: [] })
  })
})
