import { type Body, blocks, type Message, shortHash, withoutCacheControl } from "../context/content"

export interface ContextFingerprint {
  system: string
  tools: string
  skills: string[]
  given?: ContextFingerprint
}

export const isInjected = (text: unknown) => /^<(?:recalled-context|handoff)[\s>]/.test(String(text ?? ""))

export function messageFingerprint(message: Message) {
  const own = blocks(message)
    .filter((b) => !(b.type === "text" && isInjected(b.text)))
    .map(withoutCacheControl)
  return shortHash(JSON.stringify(own), 24)
}

const hash = (value: unknown) =>
  shortHash(
    JSON.stringify(value ?? null, (key, inner) => (key === "cache_control" ? undefined : inner)),
    12,
  )

export function contextFingerprint(body: Body): ContextFingerprint {
  const skills = new Set<string>()
  for (const match of JSON.stringify(body.messages ?? []).matchAll(/Base directory for this skill: ([^\s"\\]+)/g)) skills.add(match[1].split("/").at(-1) ?? match[1])
  return { system: hash(body.system), tools: hash(body.tools), skills: [...skills].sort() }
}
