import type { Arm } from "./run"

export const ANSWER_MODEL = process.env.BENCH_ANSWER_MODEL ?? "claude-opus-5-5"

export const JUDGES = ["claude-opus-5-5", "claude-sonnet-5-5"]

export const ARMS: Arm[] = process.env.BENCH_ARMS?.split(",") ?? ["native", "native+guide", "tail", "eunoe", "rolling", "trim", "full"]
