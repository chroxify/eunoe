import { existsSync, readFileSync } from "node:fs"
import { paths } from "../../config/paths"
import { rerankQuestion } from "../prompts"
import type { RecallChunk, Reranker } from "."

interface RerankAnswer {
  answers?: { where?: { probabilities?: Record<string, number> } }
}

const TIMEOUT_MS = 4_000

export function rerankKey(): string | null {
  const env = process.env.TYPESAFE_API_KEY?.trim()
  if (env) return env
  return existsSync(paths.typesafeKey) ? readFileSync(paths.typesafeKey, "utf8").trim() : null
}

function rerankState(chunks: RecallChunk[], candidates: number[]): string {
  return candidates
    .map((index, n) => {
      const chunk = chunks[index]
      return `### ${n}\n[turn ${chunk.turn}] ${chunk.call}\n${chunk.lines.map((l) => l.slice(0, 240)).join("\n")}`
    })
    .join("\n\n")
}

export function orderByProbability(candidates: number[], probabilities: Record<string, number>): number[] {
  return candidates
    .map((_, n) => n)
    .sort((a, b) => (probabilities[String(b)] ?? 0) - (probabilities[String(a)] ?? 0) || a - b)
    .map((n) => candidates[n])
}

function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.name === "TimeoutError" ? `timeout after ${TIMEOUT_MS}ms` : error.message
}

export function jevReranker(model: string, key: string, endpoint = "https://api.typesafe.ai/v1/systemone", onError?: (reason: string) => void): Reranker {
  return async (query, chunks, candidates) => {
    if (candidates.length < 2) return candidates
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          model,
          state: rerankState(chunks, candidates),
          questions: {
            where: {
              type: "choice",
              instructions: rerankQuestion(query),
              criteria: Object.fromEntries(candidates.map((_, n) => [String(n), null])),
            },
          },
        }),
      })
      if (!response.ok) {
        const body = await response.text().catch(() => "")
        onError?.(`${response.status} ${/error_type"\s*:\s*"([^"]+)/.exec(body)?.[1] ?? body.slice(0, 60)}`.trim())
        return candidates
      }
      const probabilities = ((await response.json()) as RerankAnswer).answers?.where?.probabilities
      return probabilities && typeof probabilities === "object" ? orderByProbability(candidates, probabilities) : candidates
    } catch (error) {
      onError?.(failureReason(error))
      return candidates
    }
  }
}
