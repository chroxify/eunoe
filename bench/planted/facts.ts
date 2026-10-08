/**
 * The fact plan for one planted session: what gets hidden, where, and how it
 * is checked. Every value is drawn here, by code, from a seeded RNG, so ground
 * truth exists before any model writes a word and no answer can be guessed
 * from general knowledge.
 */

export type FactType =
  | "tool_value"   // a value printed once in tool output; the agent never repeats it in prose
  | "prose_value"  // a value printed in tool output and repeated in the agent's reply
  | "error"        // an exact error code from a failing command; never quoted in prose
  | "instruction"  // a standing instruction from the developer, given once
  | "revised"      // an instruction given, then changed later; the change is the answer
  | "superseded"   // a value printed twice with different values; the later one is current
  | "decision"     // two named approaches compared, one rejected; the rejected name is the answer
  | "promise"      // a rename left for later and never done

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

export const DEPTH_BUCKETS: Array<[string, number, number]> = [
  ["1-3", 1, 3],
  ["4-10", 4, 10],
  ["11-30", 11, 30],
  ["31-60", 31, 60],
  ["61+", 61, 1_000],
]

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

const SYLLABLES = ["ka", "ri", "mo", "tez", "vul", "dra", "pen", "sho", "gal", "nix", "oro", "bel", "quin", "zar", "lum", "fen", "tor", "wex", "yal", "cus"]
const CODENAMES = ["Heron", "Marten", "Osprey", "Tamarin", "Gecko", "Ibex", "Kestrel", "Lynx", "Narwhal", "Ocelot", "Pika", "Quokka", "Saiga", "Tapir", "Vicuna", "Wombat", "Yak", "Zorilla", "Caracal", "Dhole", "Eland", "Fossa", "Gharial", "Hoatzin"]
const B32 = "abcdefghjkmnpqrstuvwxyz23456789"

export function values(rand: () => number) {
  const pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)]
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
  const chars = (alphabet: string, n: number) => Array.from({ length: n }, () => pick([...alphabet])).join("")
  const word = (n = 2) => Array.from({ length: n }, () => pick(SYLLABLES)).join("")
  const camel = () => `${word(2)}${pick(SYLLABLES)[0].toUpperCase()}${pick(SYLLABLES).slice(1)}${word(1)[0].toUpperCase()}${word(1).slice(1)}`
  return { pick, int, chars, word, camel, hex: (n: number) => chars("0123456789abcdef", n), b32: (n: number) => chars(B32, n), codename: () => pick(CODENAMES) }
}

type Draw = ReturnType<typeof values>

const VALUE_KINDS: Array<(v: Draw) => { label: string; value: string }> = [
  (v) => ({ label: "the deployment ID printed by a staging deploy", value: `dpl_${v.b32(10)}` }),
  (v) => ({ label: "the build hash printed by a release build", value: v.hex(12) }),
  (v) => ({ label: "the migration version applied by a database migration", value: `${v.int(2024, 2026)}${String(v.int(1, 12)).padStart(2, "0")}${String(v.int(1, 28)).padStart(2, "0")}_${v.word(2)}` }),
  (v) => ({ label: "the request ID of a failing API call in a log excerpt", value: `req_${v.b32(14)}` }),
  (v) => ({ label: "the number of rows a backfill script reported updating", value: String(v.int(10_000, 999_999)) }),
  (v) => ({ label: "the preview URL a deploy printed", value: `https://${v.word(2)}-${v.b32(6)}.preview.internal` }),
  (v) => ({ label: "the trace ID from a profiler run", value: v.hex(16) }),
  (v) => ({ label: "the job ID a queued background task printed", value: `job-${v.int(100_000, 999_999)}-${v.b32(4)}` }),
  (v) => ({ label: "the checksum a bundle step printed", value: `sha256:${v.hex(10)}` }),
  (v) => ({ label: "the p95 latency in milliseconds from a load test", value: `${v.int(101, 989)}.${v.int(1, 9)}ms` }),
]

const ERROR_KINDS: Array<(v: Draw) => { label: string; value: string }> = [
  (v) => ({ label: "the error code a failing test run printed", value: `E_${v.word(2).toUpperCase()}_${v.int(1000, 9999)}` }),
  (v) => ({ label: "the error code a failed deploy printed", value: `DEPLOY_${v.word(1).toUpperCase()}${v.int(100, 999)}` }),
  (v) => ({ label: "the exit code and signal name a crashed worker printed", value: `SIG${v.word(1).toUpperCase()}${v.int(10, 99)}` }),
]

/** Instructions whose value can be checked in a later answer, explicitly or by applying it. */
const INSTRUCTION_KINDS: Array<(v: Draw) => { label: string; value: string; brief: (value: string) => string }> = [
  (v) => ({ label: "the prefix every new git branch must start with", value: `${v.word(1)}${v.word(1)}/`, brief: (x) => `every new git branch must start with the prefix \`${x}\`` }),
  (v) => ({ label: "the port the local dev server must run on", value: String(v.int(3100, 9899)), brief: (x) => `the local dev server must always run on port ${x}, never the default` }),
  (v) => ({ label: "the tag every commit message must end with", value: `[${v.word(2)}]`, brief: (x) => `every commit message must end with the tag \`${x}\`` }),
  (v) => ({ label: "the shard flag the test suite must always be run with", value: `--shard=${v.int(2, 9)}/${v.int(10, 16)}`, brief: (x) => `the test suite must always be run with the flag \`${x}\`` }),
  (v) => ({ label: "the prefix every new feature flag name must use", value: `ff_${v.word(2)}_`, brief: (x) => `every new feature flag name must start with \`${x}\`` }),
  (v) => ({ label: "the region deploys must target", value: `${v.word(1)}-${v.int(1, 9)}`, brief: (x) => `deploys must only ever target the region \`${x}\`` }),
  (v) => ({ label: "the reviewer handle every PR must be assigned to", value: `@${v.word(2)}${v.int(1, 99)}`, brief: (x) => `every PR must be assigned to the reviewer \`${x}\`` }),
  (v) => ({ label: "the environment variable that must be set before running scripts", value: `${v.word(2).toUpperCase()}_MODE=strict`, brief: (x) => `scripts must always be run with \`${x}\` set in the environment` }),
]

export interface PlanOptions {
  seed: number
  turns: number
}

/**
 * 25 facts: depths spread evenly over the buckets, each type in every bucket
 * where the session is long enough. Revised and superseded facts put their
 * first value deep and the current one at least 4 turns later.
 */
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

/** Turns before the cut where the current answer was planted (1 = the last finished turn). */
export const agoOf = (fact: Fact, turns: number) => turns - fact.plants.at(-1)!.turn + 1
