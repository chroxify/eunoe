import path from "node:path"

export const PLANT_OUT = path.join(import.meta.dir, "..", "out", "planted")

export const SESSIONS = path.join(PLANT_OUT, "sessions")

export const RUNS = path.join(PLANT_OUT, "runs")

export const CANON = path.join(PLANT_OUT, "canon")
