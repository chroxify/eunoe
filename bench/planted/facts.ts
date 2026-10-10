import { B32, CODENAMES, DEPTH_BUCKETS, ERROR_KINDS, INSTRUCTION_KINDS, SYLLABLES, VALUE_KINDS } from "./constants"

export type FactType =
  | "tool_value"
  | "prose_value"
  | "error"
  | "instruction"
  | "revised"
  | "superseded"
  | "decision"
  | "promise"

export interface Plant {
  turn: number
  value: string
}

export interface Fact {
  id: string
  type: FactType
  label: string
  answer: string
  stale?: string
  plants: Plant[]
  implicit?: boolean
  brief: string
}

export const bucketOf = (ago: number) => DEPTH_BUCKETS.find(([, lo, hi]) => ago >= lo && ago <= hi)?.[0] ?? "61+"

export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function values(rand: () => number) {
  const pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)]
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
  const chars = (alphabet: string, n: number) => Array.from({ length: n }, () => pick([...alphabet])).join("")
  const word = (n = 2) => Array.from({ length: n }, () => pick(SYLLABLES)).join("")
  const camel = () => `${word(2)}${pick(SYLLABLES)[0].toUpperCase()}${pick(SYLLABLES).slice(1)}${word(1)[0].toUpperCase()}${word(1).slice(1)}`
  return { pick, int, chars, word, camel, hex: (n: number) => chars("0123456789abcdef", n), b32: (n: number) => chars(B32, n), codename: () => pick(CODENAMES) }
}

export type Draw = ReturnType<typeof values>

export interface PlanOptions {
  seed: number
  turns: number
}

export function planFacts({ seed, turns }: PlanOptions): Fact[] {
  const rand = rng(seed)
  const v = values(rand)
  const used = new Set<number>()
  const turnAt = (ago: number) => {
    let turn = Math.max(1, Math.min(turns, turns - ago + 1))
    while (used.has(turn) && turn > 1) turn -= 1
    while (used.has(turn) && turn < turns) turn += 1
    used.add(turn)
    return turn
  }
  const agoIn = (bucket: number) => {
    const [, lo, hi] = DEPTH_BUCKETS[bucket]
    return v.int(lo, Math.min(hi, turns - 1))
  }
  const facts: Fact[] = []
  let n = 0
  const id = () => `f${String(++n).padStart(2, "0")}`
  const layout: Array<[FactType, number[]]> = [
    ["tool_value", [0, 0, 1, 2, 3, 4]],
    ["prose_value", [0, 2, 4]],
    ["error", [1, 3]],
    ["instruction", [1, 2, 3, 4]],
    ["revised", [1, 3, 4]],
    ["superseded", [0, 2]],
    ["decision", [1, 3, 4]],
    ["promise", [2, 4]],
  ]
  const valueKinds = [...VALUE_KINDS].sort(() => rand() - 0.5)
  const instructionKinds = [...INSTRUCTION_KINDS].sort(() => rand() - 0.5)
  const codenames = new Set<string>()
  const freshCodename = () => {
    let name = v.codename()
    while (codenames.has(name)) name = v.codename()
    codenames.add(name)
    return name
  }
  let valueIndex = 0
  let instructionIndex = 0
  for (const [type, buckets] of layout) {
    for (const bucket of buckets) {
      const ago = agoIn(bucket)
      if (type === "tool_value" || type === "prose_value") {
        const kind = valueKinds[valueIndex++ % valueKinds.length](v)
        facts.push({ id: id(), type, label: kind.label, answer: kind.value, plants: [{ turn: turnAt(ago), value: kind.value }], brief: kind.label })
      } else if (type === "error") {
        const kind = v.pick(ERROR_KINDS)(v)
        facts.push({ id: id(), type, label: kind.label, answer: kind.value, plants: [{ turn: turnAt(ago), value: kind.value }], brief: kind.label })
      } else if (type === "superseded") {
        const kind = valueKinds[valueIndex++ % valueKinds.length](v)
        const second = valueKinds[(valueIndex - 1) % valueKinds.length](v).value
        const firstAgo = Math.min(turns - 1, ago + v.int(6, 20))
        facts.push({ id: id(), type, label: kind.label, answer: second, stale: kind.value, plants: [{ turn: turnAt(firstAgo), value: kind.value }, { turn: turnAt(ago), value: second }], brief: kind.label })
      } else if (type === "instruction" || type === "revised") {
        const kind = instructionKinds[instructionIndex++ % instructionKinds.length]
        const first = kind(v)
        if (type === "instruction") {
          facts.push({ id: id(), type, label: first.label, answer: first.value, plants: [{ turn: turnAt(ago), value: first.value }], implicit: true, brief: first.brief(first.value) })
        } else {
          const next = kind(v)
          const firstAgo = Math.min(turns - 1, ago + v.int(8, 25))
          facts.push({ id: id(), type, label: first.label, answer: next.value, stale: first.value, plants: [{ turn: turnAt(firstAgo), value: first.value }, { turn: turnAt(ago), value: next.value }], implicit: true, brief: `${first.brief(first.value)}; later changed so that ${next.brief(next.value)}` })
        }
      } else if (type === "decision") {
        const chosen = freshCodename()
        const rejected = freshCodename()
        facts.push({ id: id(), type, label: "the codename of the approach that was considered and rejected", answer: rejected, stale: chosen, plants: [{ turn: turnAt(ago), value: `${chosen}|${rejected}` }], brief: `approach "${chosen}" is chosen and approach "${rejected}" is rejected` })
      } else if (type === "promise") {
        const from = v.camel()
        const to = v.camel()
        facts.push({ id: id(), type, label: "the rename that was deferred to later", answer: to, plants: [{ turn: turnAt(ago), value: `${from}|${to}` }], brief: `renaming \`${from}\` to \`${to}\` is deferred to later and never done` })
      }
    }
  }
  return facts
}

export const agoOf = (fact: Fact, turns: number) => turns - fact.plants.at(-1)!.turn + 1
