export const DEPTH_BUCKETS: Array<[string, number, number]> = [
  ["1-3", 1, 3],
  ["4-10", 4, 10],
  ["11-30", 11, 30],
  ["31-60", 31, 60],
  ["61+", 61, 1_000],
]

const SYLLABLES = ["ka", "ri", "mo", "tez", "vul", "dra", "pen", "sho", "gal", "nix", "oro", "bel", "quin", "zar", "lum", "fen", "tor", "wex", "yal", "cus"]

const CODENAMES = [
  "Heron",
  "Marten",
  "Osprey",
  "Tamarin",
  "Gecko",
  "Ibex",
  "Kestrel",
  "Lynx",
  "Narwhal",
  "Ocelot",
  "Pika",
  "Quokka",
  "Saiga",
  "Tapir",
  "Vicuna",
  "Wombat",
  "Yak",
  "Zorilla",
  "Caracal",
  "Dhole",
  "Eland",
  "Fossa",
  "Gharial",
  "Hoatzin",
]

const B32 = "abcdefghjkmnpqrstuvwxyz23456789"

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

export type FactType = "tool_value" | "prose_value" | "error" | "instruction" | "revised" | "superseded" | "decision" | "promise"

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
  const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)]
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

interface Plan {
  v: Draw
  turns: number
  turnAt: (ago: number) => number
  id: () => string
  nextValueKind: () => (typeof VALUE_KINDS)[number]
  nextInstructionKind: () => (typeof INSTRUCTION_KINDS)[number]
  freshCodename: () => string
}

type Build = (plan: Plan, ago: number) => Fact

const valueFact =
  (type: FactType): Build =>
  (plan, ago) => {
    const kind = plan.nextValueKind()(plan.v)
    return { id: plan.id(), type, label: kind.label, answer: kind.value, plants: [{ turn: plan.turnAt(ago), value: kind.value }], brief: kind.label }
  }

const builders: Record<FactType, Build> = {
  tool_value: valueFact("tool_value"),
  prose_value: valueFact("prose_value"),
  error: (plan, ago) => {
    const kind = plan.v.pick(ERROR_KINDS)(plan.v)
    return { id: plan.id(), type: "error", label: kind.label, answer: kind.value, plants: [{ turn: plan.turnAt(ago), value: kind.value }], brief: kind.label }
  },
  superseded: (plan, ago) => {
    const kind = plan.nextValueKind()
    const first = kind(plan.v)
    const second = kind(plan.v).value
    const firstAgo = Math.min(plan.turns - 1, ago + plan.v.int(6, 20))
    return {
      id: plan.id(),
      type: "superseded",
      label: first.label,
      answer: second,
      stale: first.value,
      plants: [
        { turn: plan.turnAt(firstAgo), value: first.value },
        { turn: plan.turnAt(ago), value: second },
      ],
      brief: first.label,
    }
  },
  instruction: (plan, ago) => {
    const first = plan.nextInstructionKind()(plan.v)
    return { id: plan.id(), type: "instruction", label: first.label, answer: first.value, plants: [{ turn: plan.turnAt(ago), value: first.value }], implicit: true, brief: first.brief(first.value) }
  },
  revised: (plan, ago) => {
    const kind = plan.nextInstructionKind()
    const first = kind(plan.v)
    const next = kind(plan.v)
    const firstAgo = Math.min(plan.turns - 1, ago + plan.v.int(8, 25))
    return {
      id: plan.id(),
      type: "revised",
      label: first.label,
      answer: next.value,
      stale: first.value,
      plants: [
        { turn: plan.turnAt(firstAgo), value: first.value },
        { turn: plan.turnAt(ago), value: next.value },
      ],
      implicit: true,
      brief: `${first.brief(first.value)}; later changed so that ${next.brief(next.value)}`,
    }
  },
  decision: (plan, ago) => {
    const chosen = plan.freshCodename()
    const rejected = plan.freshCodename()
    return {
      id: plan.id(),
      type: "decision",
      label: "the codename of the approach that was considered and rejected",
      answer: rejected,
      stale: chosen,
      plants: [{ turn: plan.turnAt(ago), value: `${chosen}|${rejected}` }],
      brief: `approach "${chosen}" is chosen and approach "${rejected}" is rejected`,
    }
  },
  promise: (plan, ago) => {
    const from = plan.v.camel()
    const to = plan.v.camel()
    return {
      id: plan.id(),
      type: "promise",
      label: "the rename that was deferred to later",
      answer: to,
      plants: [{ turn: plan.turnAt(ago), value: `${from}|${to}` }],
      brief: `renaming \`${from}\` to \`${to}\` is deferred to later and never done`,
    }
  },
}

function cycle<T>(items: T[]): () => T {
  let index = 0
  return () => items[index++ % items.length]
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
  let n = 0
  const codenames = new Set<string>()
  const plan: Plan = {
    v,
    turns,
    turnAt,
    id: () => `f${String(++n).padStart(2, "0")}`,
    nextValueKind: cycle([...VALUE_KINDS].sort(() => rand() - 0.5)),
    nextInstructionKind: cycle([...INSTRUCTION_KINDS].sort(() => rand() - 0.5)),
    freshCodename: () => {
      let name = v.codename()
      while (codenames.has(name)) name = v.codename()
      codenames.add(name)
      return name
    },
  }
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
  return layout.flatMap(([type, buckets]) => buckets.map((bucket) => builders[type](plan, agoIn(bucket))))
}

export const agoOf = (fact: Fact, turns: number) => turns - fact.plants.at(-1)!.turn + 1
