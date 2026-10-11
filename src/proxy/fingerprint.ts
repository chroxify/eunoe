import { shortHash } from "../context/content"
import type { Body } from "../context/types"
import { FINGERPRINT_LENGTH, SKILL_MARKER } from "./constants"
import type { ContextFingerprint } from "./types"

const hash = (value: unknown) =>
  shortHash(
    JSON.stringify(value ?? null, (key, inner) => (key === "cache_control" ? undefined : inner)),
    FINGERPRINT_LENGTH,
  )

export function contextFingerprint(body: Body): ContextFingerprint {
  const skills = new Set<string>()
  for (const match of JSON.stringify(body.messages ?? []).matchAll(SKILL_MARKER)) skills.add(match[1].split("/").at(-1)!)
  return { system: hash(body.system), tools: hash(body.tools), skills: [...skills].sort() }
}
