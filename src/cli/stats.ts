import { STATUS_WINDOW_MS } from "./constants"
import type { RequestRecord } from "./types"

export interface SessionStats {
  context: number
  plain: number | null
  turns: number | null
  requests: number
  folds: number
  lastSeen: string
}

export interface Totals {
  requests: number
  cacheRead: number
  cacheWrite: number
  uncached: number
  folds: number
  lastFold: string | null
  sent: number
  saved: number
}

const THREAD_SUFFIX = /-[0-9a-f]{24}$/

export const sessionOf = (record: RequestRecord): string | null => (typeof record.thread === "string" ? record.thread.replace(THREAD_SUFFIX, "") : null)

const plainTokens = (record: RequestRecord): number | null => (record.charsIn > 0 && record.charsOut > 0 && record.input > 0 ? Math.round(record.input * record.charsIn / record.charsOut) : null)

export function withinWindow(records: RequestRecord[], now = Date.now(), window = STATUS_WINDOW_MS): RequestRecord[] {
  return records.filter((record) => now - Date.parse(record.ts) <= window)
}

export function perSession(records: RequestRecord[]): Map<string, SessionStats> {
  const stats = new Map<string, SessionStats>()
  for (const record of records) {
    const id = sessionOf(record)
    if (!id || !(record.input > 0)) continue
    const previous = stats.get(id)
    stats.set(id, {
      context: record.input,
      plain: plainTokens(record),
      turns: typeof record.turns === "number" ? record.turns : previous?.turns ?? null,
      requests: (previous?.requests ?? 0) + 1,
      folds: (previous?.folds ?? 0) + (record.compacted ? 1 : 0),
      lastSeen: record.ts,
    })
  }
  return stats
}

export function totals(records: RequestRecord[]): Totals {
  const out: Totals = { requests: 0, cacheRead: 0, cacheWrite: 0, uncached: 0, folds: 0, lastFold: null, sent: 0, saved: 0 }
  for (const record of records) {
    if (!(record.input > 0)) continue
    out.requests += 1
    out.cacheRead += record.cacheRead ?? 0
    out.cacheWrite += record.cacheWrite ?? 0
    out.uncached += record.uncached ?? 0
    if (record.compacted) {
      out.folds += 1
      out.lastFold = record.ts
    }
    const plain = plainTokens(record)
    if (plain !== null) {
      out.sent += record.input
      out.saved += plain - record.input
    }
  }
  return out
}

export const savedShare = (context: number, plain: number | null): number | null => (plain && plain > context ? 1 - context / plain : plain ? 0 : null)
