import { DEFAULT_RATIO } from "../../core/estimate"
import { NATIVE_SUMMARY_CHARS, REPLAY_NATIVE_COMPACT_AT } from "../replay"
import type { RequestRecord } from "./inspect"

export interface SessionStats {
  context: number
  fixed: number | null
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

const sessionOf = (record: RequestRecord): string | null => (typeof record.thread === "string" ? record.thread.replace(/-[0-9a-f]{24}$/, "") : null)

const inputOf = (record: RequestRecord) => record.input ?? 0

function scaled(record: RequestRecord, chars: number | undefined): number | null {
  const input = inputOf(record)
  const charsOut = record.charsOut ?? 0
  return input > 0 && charsOut > 0 && chars && chars > 0 ? Math.round((input * chars) / charsOut) : null
}

export function savedTokens(record: RequestRecord): number | null {
  const plain = scaled(record, record.charsIn)
  return plain === null ? null : plain - inputOf(record)
}

export function withinWindow(records: RequestRecord[], now = Date.now(), window = 24 * 3_600_000): RequestRecord[] {
  return records.filter((record) => now - Date.parse(record.ts) <= window)
}

export function perSession(records: RequestRecord[]): Map<string, SessionStats> {
  const stats = new Map<string, SessionStats>()
  for (const record of records) {
    const id = sessionOf(record)
    if (!id || inputOf(record) <= 0) continue
    const previous = stats.get(id)
    stats.set(id, {
      context: inputOf(record),
      fixed: scaled(record, record.charsFixed),
      plain: scaled(record, record.charsIn),
      turns: record.turns ?? previous?.turns ?? null,
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
    if (inputOf(record) <= 0) continue
    out.requests += 1
    out.cacheRead += record.cacheRead ?? 0
    out.cacheWrite += record.cacheWrite ?? 0
    out.uncached += record.uncached ?? 0
    if (record.compacted) {
      out.folds += 1
      out.lastFold = record.ts
    }
    const saved = savedTokens(record)
    if (saved !== null) {
      out.sent += inputOf(record)
      out.saved += saved
    }
  }
  return out
}

export function savedShare(context: number, plain: number | null): number | null {
  if (!plain) return null
  return plain > context ? 1 - context / plain : 0
}

export function nativeCompactions(records: RequestRecord[]): Set<RequestRecord> {
  const summary = Math.round(NATIVE_SUMMARY_CHARS * DEFAULT_RATIO)
  const offsets = new Map<string, number>()
  const compacted = new Set<RequestRecord>()
  for (const record of records) {
    const plain = scaled(record, record.charsIn)
    const window = typeof record.window === "number" ? record.window : 0
    if (typeof record.thread !== "string" || plain === null || window <= 0) continue
    if (plain - (offsets.get(record.thread) ?? 0) <= REPLAY_NATIVE_COMPACT_AT * window) continue
    compacted.add(record)
    offsets.set(record.thread, plain - (scaled(record, record.charsFixed) ?? 0) - summary)
  }
  return compacted
}

export interface ThreadPeak {
  thread: string
  session: string
  plain: number
  sent: number
  turns: number | null
  compactions: number
  lastSeen: string
}

export function threadPeaks(records: RequestRecord[], compacted: Set<RequestRecord>): ThreadPeak[] {
  const peaks = new Map<string, ThreadPeak>()
  for (const record of records) {
    const plain = scaled(record, record.charsIn)
    const session = sessionOf(record)
    if (typeof record.thread !== "string" || !session || plain === null) continue
    const previous = peaks.get(record.thread)
    const higher = !previous || plain >= previous.plain
    peaks.set(record.thread, {
      thread: record.thread,
      session,
      plain: higher ? plain : previous.plain,
      sent: higher ? inputOf(record) : previous.sent,
      turns: record.turns ?? previous?.turns ?? null,
      compactions: (previous?.compactions ?? 0) + (compacted.has(record) ? 1 : 0),
      lastSeen: record.ts,
    })
  }
  return [...peaks.values()].sort((a, b) => b.plain - a.plain)
}
