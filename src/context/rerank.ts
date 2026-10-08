import { existsSync, readFileSync } from "node:fs"
import { paths } from "../config/constants"
import { RERANK_ENDPOINT, RERANK_LINE_CHARS, RERANK_TIMEOUT_MS } from "./constants"
import type { RecallChunk, Reranker } from "./types"

export function rerankKey(): string | null {
  const env = process.env.TYPESAFE_API_KEY?.trim()
  if (env) return env
  return existsSync(paths.typesafeKey) ? readFileSync(paths.typesafeKey, "utf8").trim() : null
}

export function rerankState(chunks: RecallChunk[], candidates: number[]): string {
  return candidates.map((index, n) => `### ${n}\n[turn ${chunks[index].turn}] ${chunks[index].call}\n${chunks[index].lines.map((l) => l.slice(0, RERANK_LINE_CHARS)).join("\n")}`).join("\n\n")
}

export function orderByProbability(candidates: number[], probabilities: Record<string, number>): number[] {
  return candidates.map((_, n) => n).sort((a, b) => (probabilities[String(b)] ?? 0) - (probabilities[String(a)] ?? 0) || a - b).map((n) => candidates[n])
}

export function jevReranker(model: string, key: string, endpoint = RERANK_ENDPOINT): Reranker {
  return async (query, chunks, candidates) => {
    if (candidates.length < 2) return candidates
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
        body: JSON.stringify({
          model,
          state: rerankState(chunks, candidates),
          questions: {
            where: { type: "choice", instructions: `Which excerpt contains the exact answer to the developer's question about this coding session: "${query}"?`, criteria: Object.fromEntries(candidates.map((_, n) => [String(n), null])) },
          },
        }),
      })
      if (!response.ok) return candidates
      const json: any = await response.json()
      const probabilities = json?.answers?.where?.probabilities
      return probabilities && typeof probabilities === "object" ? orderByProbability(candidates, probabilities) : candidates
    } catch {
      return candidates
    }
  }
}
