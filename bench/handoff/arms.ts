import type { ArmSpec } from "../arms"
import { HANDOFF_ARMS, PROXIES, SCENARIOS } from "./constants"

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
