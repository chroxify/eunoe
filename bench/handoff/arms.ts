import type { ArmSpec } from "../arms"

const BASE = { mode: "compact", compactAt: 0.99, window: 10_000_000, search: "markdown" }

export const PROXIES: ArmSpec[] = [
  { name: "hand-bare", proxy: "hand-bare", port: 8840, config: { ...BASE, rerank: "off", eval: { evidence: false, recall: false } } },
  { name: "hand-recall", proxy: "hand-recall", port: 8841, config: { ...BASE, rerank: "jev-preview", eval: { evidence: true, recall: true, rerank: { model: "jev-preview" } } } },
  { name: "hand-guide", proxy: "hand-guide", port: 8842, config: { ...BASE, rerank: "off", eval: { strategy: "guide", evidence: false, recall: false } } },
  {
    name: "hand-recall-wide",
    proxy: "hand-recall-wide",
    port: 8843,
    config: { ...BASE, rerank: "jev-preview", eval: { evidence: true, recall: true, rerank: { model: "jev-preview" }, recallOptions: { maxChars: 30_000, maxCharsMulti: 90_000, perQuery: 6 } } },
  },
]

export const HANDOFF_ARMS: HandoffArm[] = [
  { name: "cold", proxy: "hand-bare" },
  { name: "cold+hint", proxy: "hand-guide", hint: true },
  { name: "full", proxy: "hand-bare", inject: "full" },
  { name: "folded", proxy: "hand-bare", inject: "folded" },
  { name: "folded-capped", proxy: "hand-bare", inject: "folded-capped" },
  { name: "rules", proxy: "hand-bare", inject: "rules" },
  { name: "brief-haiku", proxy: "hand-bare", inject: "brief-haiku" },
  { name: "brief-sonnet", proxy: "hand-bare", inject: "brief-sonnet" },
  { name: "brief-opus", proxy: "hand-bare", inject: "brief-opus" },
  { name: "recall", proxy: "hand-recall", recall: true },
  { name: "rules+recall", proxy: "hand-recall", inject: "rules", recall: true },
  { name: "brief-sonnet+recall", proxy: "hand-recall", inject: "brief-sonnet", recall: true },
  { name: "folded-capped+recall", proxy: "hand-recall", inject: "folded-capped", recall: true },
  { name: "folded+recall", proxy: "hand-recall", inject: "folded", recall: true },
  { name: "recall+", proxy: "hand-recall-wide", recall: true, users: true },
  { name: "rules+recall+", proxy: "hand-recall-wide", inject: "rules", recall: true, users: true },
  { name: "brief-opus+recall+", proxy: "hand-recall-wide", inject: "brief-opus", recall: true, users: true },
  { name: "folded-cap40+recall+", proxy: "hand-recall-wide", inject: "folded-cap40", recall: true, users: true },
  { name: "folded-cap60+recall+", proxy: "hand-recall-wide", inject: "folded-cap60", recall: true, users: true },
  { name: "folded-capped+recall+", proxy: "hand-recall-wide", inject: "folded-capped", recall: true, users: true },
  { name: "recall-all+", proxy: "hand-recall-wide", recall: true, users: true, allSources: true },
  { name: "auto", proxy: "hand-recall-wide", inject: "folded-cap60", recall: true, users: true, pick: true, allSources: true },
  { name: "auto-full", proxy: "hand-recall-wide", inject: "folded", recall: true, users: true, pick: true, allSources: true },
  { name: "multi2+recall+", proxy: "hand-recall-wide", inject: "multi", multi: 2, recall: true, users: true, pick: true, allSources: true },
  { name: "agent", proxy: "hand-bare", agent: "auto" },
  { name: "agent-manual", proxy: "hand-bare", agent: "manual" },
  { name: "agent2", proxy: "hand-bare", agent: "auto", section: "v2" },
  { name: "agent2-manual", proxy: "hand-bare", agent: "manual", section: "v2" },
  { name: "agent3", proxy: "hand-bare", agent: "auto", section: "v3" },
  { name: "agent4", proxy: "hand-bare", agent: "auto", section: "v4", load: "file" },
  { name: "agent4-manual", proxy: "hand-bare", agent: "manual", section: "v4", load: "file" },
  { name: "agent4b", proxy: "hand-bare", agent: "auto", section: "v4b", load: "brief" },
  { name: "agent4b-manual", proxy: "hand-bare", agent: "manual", section: "v4b", load: "brief" },
  { name: "multi-all+recall+", proxy: "hand-recall-wide", inject: "multi", multi: 99, recall: true, users: true, pick: true, allSources: true },
]

export const SCENARIOS = ["bug", "continue", "rules"] as const

export interface HandoffArm {
  name: string
  proxy: string
  inject?: string
  recall?: boolean
  users?: boolean
  hint?: boolean
  pick?: boolean
  allSources?: boolean
  multi?: number
  agent?: "auto" | "manual"
  section?: string
  load?: "file" | "brief"
}

export type Scenario = (typeof SCENARIOS)[number] | "new"

export function handoffArm(name: string): HandoffArm {
  const arm = HANDOFF_ARMS.find((a) => a.name === name)
  if (!arm) throw new Error(`unknown handoff arm ${name}; known: ${HANDOFF_ARMS.map((a) => a.name).join(", ")}`)
  return arm
}

export function proxyOf(arm: HandoffArm): ArmSpec {
  return PROXIES.find((p) => p.proxy === arm.proxy)!
}
