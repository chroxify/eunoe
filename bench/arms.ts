/**
 * Every strategy under test, with the eunoe proxy config that produces it.
 * Both suites share this registry. An arm is the context the answering model
 * gets: `native` arms resume Claude Code's own compaction instead of the
 * uncompacted session; `uncut` arms never receive a window header, so the
 * proxy never folds them. `default` is eunoe as shipped; the older arms turn
 * evidence, recall and reranking off through `eval` so the ablations keep
 * their meaning.
 */
export interface ArmSpec {
  name: string
  proxy: string
  port: number
  native?: boolean
  uncut?: boolean
  config: Record<string, unknown>
}

const cut = { mode: "compact", compactAt: 0.95, keepTurns: "all", search: "markdown", rerank: "off" }
const bare = { evidence: false, recall: false }
const trim = { ...cut, eval: { strategy: "trim", ...bare } }

export const ARMS: ArmSpec[] = [
  { name: "native", proxy: "observe", port: 8810, native: true, uncut: true, config: { mode: "compact", compactAt: 0.99, window: 10_000_000, rerank: "off", eval: bare } },
  { name: "native+guide", proxy: "guide", port: 8811, native: true, config: { mode: "compact", search: "markdown", rerank: "off", eval: { strategy: "guide", ...bare } } },
  { name: "full", proxy: "observe", port: 8810, uncut: true, config: { mode: "compact", compactAt: 0.99, window: 10_000_000, rerank: "off", eval: bare } },
  { name: "tail", proxy: "tail", port: 8812, config: { mode: "compact", search: "markdown", rerank: "off", eval: { strategy: "tail", ...bare } } },
  { name: "eunoe", proxy: "eunoe", port: 8813, config: { ...cut, eval: { forceCut: true, ...bare } } },
  { name: "rolling", proxy: "rolling", port: 8814, config: { ...cut, eval: { forceCut: true, rolling: { keep: 3, budget: 100_000 }, ...bare } } },
  { name: "trim", proxy: "trim", port: 8815, config: trim },

  { name: "native+recall", proxy: "native-recall", port: 8820, native: true, config: { mode: "compact", search: "markdown", rerank: "off", eval: { strategy: "guide", evidence: false, recall: true } } },
  { name: "eunoe+evidence", proxy: "eunoe-evidence", port: 8821, config: { ...cut, eval: { forceCut: true, evidence: true, recall: false } } },
  { name: "eunoe+recall", proxy: "eunoe-recall", port: 8822, config: { ...cut, eval: { forceCut: true, evidence: false, recall: true } } },
  { name: "eunoe+both", proxy: "eunoe-both", port: 8823, config: { ...cut, eval: { forceCut: true, evidence: true, recall: true } } },
  { name: "rolling+both", proxy: "rolling-both", port: 8824, config: { ...cut, eval: { forceCut: true, rolling: { keep: 3, budget: 100_000 }, evidence: true, recall: true } } },
  { name: "trim+evidence", proxy: "trim-evidence", port: 8825, config: { ...cut, eval: { strategy: "trim", evidence: true, recall: false } } },
  { name: "trim+both", proxy: "trim-both", port: 8826, config: { ...cut, eval: { strategy: "trim", evidence: true, recall: true } } },
  { name: "rolling+both2", proxy: "rolling-both2", port: 8827, config: { ...cut, eval: { forceCut: true, rolling: { keep: 3, budget: 100_000 }, evidence: true, recall: true } } },
  { name: "rolling+both3", proxy: "rolling-both3", port: 8828, config: { ...cut, eval: { forceCut: true, rolling: { keep: 3, budget: 100_000 }, evidence: true, recall: true, rerank: { model: "jev-preview" } } } },
  { name: "default", proxy: "default", port: 8829, config: { mode: "default", search: "markdown", eval: { forceCut: true } } },
]

export function armSpec(name: string): ArmSpec {
  const spec = ARMS.find((a) => a.name === name)
  if (!spec) throw new Error(`unknown arm ${name}; known: ${ARMS.map((a) => a.name).join(", ")}`)
  return spec
}
