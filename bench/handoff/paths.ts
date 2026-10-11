import path from "node:path"

export const HANDOFF_OUT = path.join(import.meta.dir, "..", "out", "handoff")

export const PROMPTS = path.join(HANDOFF_OUT, "prompts")

export const INJECT = path.join(HANDOFF_OUT, "inject")

export const RUNS = path.join(HANDOFF_OUT, "runs")
