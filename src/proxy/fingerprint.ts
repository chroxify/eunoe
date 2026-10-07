import type { Body } from "../context/types"
import { FINGERPRINT_LENGTH, SKILL_MARKER } from "./constants"
import type { ContextFingerprint } from "./types"

const hash = (value: unknown) => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(JSON.stringify(value ?? null, (key, inner) => (key === "cache_control" ? undefined : inner)))
  return hasher.digest("hex").slice(0, FINGERPRINT_LENGTH)
}

export function contextFingerprint(body: Body): ContextFingerprint {
  const skills = new Set<string>()
  for (const match of JSON.stringify(body.messages ?? []).matchAll(SKILL_MARKER)) skills.add(match[1].split("/").at(-1)!)
  return { system: hash(body.system), tools: hash(body.tools), skills: [...skills].sort() }
}
