import type { ArmSpec } from "./arms"

export const CUT = { mode: "compact", compactAt: 0.95, keepTurns: "all", search: "markdown", rerank: "off" }
export const BARE = { evidence: false, recall: false }
export const TRIM = { ...CUT, eval: { strategy: "trim", ...BARE } }

export const ARMS: ArmSpec[] = [
  { name: "native", proxy: "observe", port: 8810, native: true, uncut: true, config: { mode: "compact", compactAt: 0.99, window: 10_000_000, rerank: "off", eval: BARE } },
  { name: "native+guide", proxy: "guide", port: 8811, native: true, config: { mode: "compact", search: "markdown", rerank: "off", eval: { strategy: "guide", ...BARE } } },
  { name: "full", proxy: "observe", port: 8810, uncut: true, config: { mode: "compact", compactAt: 0.99, window: 10_000_000, rerank: "off", eval: BARE } },
  { name: "tail", proxy: "tail", port: 8812, config: { mode: "compact", search: "markdown", rerank: "off", eval: { strategy: "tail", ...BARE } } },
  { name: "eunoe", proxy: "eunoe", port: 8813, config: { ...CUT, eval: { forceCut: true, ...BARE } } },
  { name: "rolling", proxy: "rolling", port: 8814, config: { ...CUT, eval: { forceCut: true, rolling: { keep: 3, budget: 100_000 }, ...BARE } } },
  { name: "trim", proxy: "trim", port: 8815, config: TRIM },

  { name: "native+recall", proxy: "native-recall", port: 8820, native: true, config: { mode: "compact", search: "markdown", rerank: "off", eval: { strategy: "guide", evidence: false, recall: true } } },
  { name: "eunoe+evidence", proxy: "eunoe-evidence", port: 8821, config: { ...CUT, eval: { forceCut: true, evidence: true, recall: false } } },
  { name: "eunoe+recall", proxy: "eunoe-recall", port: 8822, config: { ...CUT, eval: { forceCut: true, evidence: false, recall: true } } },
  { name: "eunoe+both", proxy: "eunoe-both", port: 8823, config: { ...CUT, eval: { forceCut: true, evidence: true, recall: true } } },
  { name: "rolling+both", proxy: "rolling-both", port: 8824, config: { ...CUT, eval: { forceCut: true, rolling: { keep: 3, budget: 100_000 }, evidence: true, recall: true } } },
  { name: "trim+evidence", proxy: "trim-evidence", port: 8825, config: { ...CUT, eval: { strategy: "trim", evidence: true, recall: false } } },
  { name: "trim+both", proxy: "trim-both", port: 8826, config: { ...CUT, eval: { strategy: "trim", evidence: true, recall: true } } },
  { name: "rolling+both2", proxy: "rolling-both2", port: 8827, config: { ...CUT, eval: { forceCut: true, rolling: { keep: 3, budget: 100_000 }, evidence: true, recall: true } } },
  { name: "rolling+both3", proxy: "rolling-both3", port: 8828, config: { ...CUT, eval: { forceCut: true, rolling: { keep: 3, budget: 100_000 }, evidence: true, recall: true, rerank: { model: "jev-preview" } } } },
  { name: "default", proxy: "default", port: 8829, config: { mode: "default", search: "markdown", eval: { forceCut: true } } },
  { name: "default-nocap", proxy: "default-nocap", port: 8830, config: { mode: "default", search: "markdown", turnCap: "off", eval: { forceCut: true } } },
  { name: "default-cap5k", proxy: "default-cap5k", port: 8831, config: { mode: "default", search: "markdown", turnCap: 5_000, eval: { forceCut: true } } },
]
