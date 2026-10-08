# eunoe benchmark: specification

The pre-registered design of everything in `bench/`, in four parts. Parts A
and B were written and frozen before their runs; Part C before any component
change was adopted; Part D is the dated log of every change made afterwards.
`RESULTS.md` reports against this document. Section numbers are prefixed by
part (A6, B2, C3) so cross-references stay unambiguous.

## Part A: planted-fact suite

Written 2026-10-08, before any arm ran on this suite. Sections A1–A7 were
frozen once the first test-split run started; changes after that are in
Part D.

### A1. Question

When a long Claude Code session runs out of context, does a context strategy
leave the agent remembering more of the session than Claude Code's own
compaction, and is that memory high and even across every kind of fact and
every distance back?

The real-session suite (Part B: real sessions, LLM-written questions, LLM judges) could not answer
this: its questions were written by a model reading the session, which asks
about what is memorable, and a compaction summary keeps exactly that. Native
scored 89% and every arm crowded the ceiling. This suite measures the facts a
summary drops, with ground truth that exists before any model is involved.

### A2. Sessions

36 sessions, 90–120 user turns each, on 12 real repositories (3 per repo).

- **Planted facts.** Code draws 25 facts per session from a seeded RNG
  (`facts.ts`): random IDs, hashes, codes, names and flags that cannot be
  guessed. Each type has fixed depths so every distance bucket (1–3, 4–10,
  11–30, 31–60, 61+ turns before the cut) gets about five facts.

  | type | where it lives | count |
  |---|---|---|
  | tool_value | one command's output, never repeated in prose | 6 |
  | prose_value | a command's output and the agent's reply | 3 |
  | error | a failed command's output, never quoted | 2 |
  | instruction | a standing rule in one developer message | 4 |
  | revised | a rule given, then changed 8–25 turns later | 3 |
  | superseded | a value printed twice; the later is current | 2 |
  | decision | two named approaches, one rejected, in a reply | 3 |
  | promise | a rename deferred and never done | 2 |

- **Story.** Opus writes the developer's messages, the agent's steps and
  replies, the output of commands that change things, and one question per
  fact (plus a task per instruction, §A4). It never chooses a value.
- **Real context.** Read-only steps (file reads, grep, ls, git log) are
  executed on the real repository, so most tokens are genuine code.
- **Verified placement.** Code checks that every value appears exactly where
  the plan puts it (tool output only, prose only, the developer's message) and
  nowhere else in the session, and that no question or task reveals its
  answer. A chunk that fails is rewritten with the failures listed.
- **The cut** is at the end of the last turn. The session is sized so the cut
  is realistic (~300–500k tokens).

### A3. Split

Sessions with index divisible by 3 are **dev** (12); the rest are **test**
(24). Methods are developed and tuned on dev only. Test is run once per frozen
configuration; the configuration (arm name + proxy config) is recorded in the
run directory before it starts. A test result is never used to change a
method and then reported as if it were fresh.

### A4. Measurement

Every arm resumes the same session copy through its own eunoe proxy, with the
same answering model (Sonnet 5.5), and gets two messages:

1. **Tasks**: one request per instruction fact that can only be done right by
   applying the rule, without naming it ("spin up the dev server, what exact
   command will you run?"). Measures whether it *uses* what it knows.
2. **Recall**: one question per fact; answers are exact values only. Measures
   whether it *knows*.

Scoring is exact match after normalisation (case, quotes, thousands
separators). Verdicts: **correct** (current value present), **stale** (only
the old value of a revised/superseded fact, or the chosen approach instead of
the rejected one), **unknown** (declined), **wrong** (anything else). No
judge model.

Every arm gets the same system prompt and tool list (the proxy's canonical
header, captured from the uncompacted resume). The native arms resume Claude
Code's own `/compact` of the session, made once per session with the
answering model and reused by every run.

Agents may search the session's transcript (read-only) in every arm,
including native, whose summary already points to it. Lookups outside the
transcript are counted and reported.

### A5. Arms

Baselines: `native` (Claude Code's compaction), `native+guide` (plus
eunoe's transcript-search instructions), `full` (no compaction; the ceiling),
`tail` (drop oldest turns), `eunoe` (prompt + reply per turn), `rolling`
(last 3 turns whole), `trim` (every finished turn reduced).

Methods under development (see `arms.ts`):

- **evidence**: when a turn is reduced, keep the salient lines of its command
  output verbatim (errors, IDs, hashes, URLs, numbers; at most 4 lines per
  call, 1,600 characters per turn). Generic patterns, not the planted labels.
- **recall**: on each new prompt, search the output that is no longer in
  context (BM25 over 12-line windows) and attach the best matches to that
  prompt, quoted exactly. Computed once per prompt and reused, so the request
  stays cache-stable.
- combinations of the above with eunoe, rolling and trim, and `native+recall`
  (retrieval from the transcript on top of Claude Code's own compaction).

### A6. Hypotheses (test split)

The unit is the session: per-session accuracy, paired against native,
bootstrap 95% interval over sessions.

- **P1** The final strategy recalls more than native: lower bound of the
  paired difference > 0.
- **P2** The final strategy recalls ≥ 90% overall.
- **P3** It recalls ≥ 85% in every depth bucket and every fact type.
- **P4** It applies instructions in tasks at least as well as native
  (lower bound of the difference > −5 points).
- **P5** Its stale rate is ≤ native's.
- **P6** It does not need more tokens per request than `full` at the cut
  (median context at recall).

The final strategy is the dev-split winner by overall recall, ties broken by
the lowest worst-bucket accuracy, then by context size. It is named in the
run directory before the test run.

### A7. Generalisation

The planted suite controls what is measured; real sessions show whether it
holds outside it. The final strategy and native are also run on the real-session suite's 27
real points with the real-session suite's vetted questions and judges, and reported next to
the real-session suite's existing arms. A method that wins here and loses there is reported
as not general.

### A8. Limits stated up front

- Sessions are written by a model, with real code underneath. Their style is
  close to a real session but not one.
- Planted values are distinctive strings. Real facts are sometimes vaguer
  ("the bug was in the retry loop"); the real-session suite covers those.
- One answering model (Sonnet 5.5). Native compaction uses the same model,
  as it would for a user running Sonnet.
- The cut is at a turn boundary, where `/compact` runs. Automatic compaction
  in the middle of a turn is not modelled.

## Part B: real-session suite

Written 2026-10-07, before the run. Nothing below was executed against this
design beforehand. The hypotheses, arms, sample size and pass criteria are
fixed here first; the run then reports against them, including whatever
fails. It was committed before `points.json` was generated.


### B1. The claim

> When a long Claude Code session runs out of context, eunoe leaves the agent
> knowing more and continuing the work better than built-in compaction — and
> the gain comes from *what* it keeps, not from keeping more.

Three load-bearing phrases, each with its own evidence:

- **knowing more** — recall (H1–H4), and how it was found (H9)
- **continuing better** — task continuation (H5–H6), with skills and instructions intact (H10)
- **not from keeping more** — a budget-matched baseline (H2)

#### What we do not claim

- **Not "better at coding."** Same model, same tools. Only the context differs.
- **Not "cheaper in every case."** eunoe's post-cut context is roughly 2× native's. Tokens are reported alongside every score; the reader weighs them. What *is* cheaper is the compaction itself: no summary call (H7).
- **Not "generalises to every developer."** Every session is from one person's machine (§B9).


### B2. Pre-registered hypotheses

Each is a paired comparison across cut points. The statistic is a 95%
bootstrap confidence interval over **per-point totals**, never per question:
twelve questions inside one point are correlated, and counting them separately
would inflate n tenfold. A hypothesis passes only if the CI excludes zero in
the predicted direction.

| # | hypothesis | passes if | expectation going in |
|---|---|---|---|
| **H1** | eunoe recalls more than native | eunoe − native > 0 | pass, large (bench2: +11%) |
| **H2** | **the structure matters:** eunoe is non-inferior to a sliding window given *more* tokens | eunoe − tail ≥ −2 points (of 20) | **unknown** — the smoke point had tail ahead |
| **H3** | native's gap is not a search-skill artefact | (native+guide) − native < +5 | expected small |
| **H4** | eunoe fails honestly | eunoe's *wrong*-answer rate < native's | expected pass |
| **H5** | eunoe continues the task better | continuation score > native | expected pass, moderate |
| **H6** | eunoe respects standing instructions after a cut | fewer violations than native | expected pass |
| **H7** | compaction itself is cheaper | fewer tokens and less wall time to compact, every point | pass, deterministic |
| **H8** | recent detail is worth keeping | rolling − trim > 0 on recall of the last 3 turns (`turnsAgo` ≤ 3), and rolling non-inferior to eunoe overall (≥ −2) | **unknown**; decides whether rolling replaces compact as the default |
| **H9** | the agent actually uses the transcript | on questions whose evidence was cut from its context, eunoe's agent finds the answer by searching for ≥ 50% of them, and those score higher than the ones it didn't search for | **unknown**; if it fails, eunoe's recall rests on what it keeps, not on search |
| **H10** | skills and instructions survive the cut | every skill loaded before the cut is still in eunoe's, rolling's and trim's context on 100% of points; native's rate is reported beside it | pass, deterministic (§B5, skills) |

#### Fallbacks, decided now

- **If H2 fails:** the public claim becomes *"matches a sliding window at half the tokens, and beats native."* Publishable, but a different sentence from §B1.
- **If H5 fails:** recall is published alone, with the statement that continuation was not demonstrated. Recall is necessary for continuation, not sufficient.
- **If H2 is borderline at N=40** (CI straddles −2): extend to N=60 *before* looking at the direction of the extra points. This rule exists so it cannot be invoked selectively.
- **Amendment, recorded 2026-10-07 23:50 UTC, before any point had scored** (`run.log` showed arms answering p01–p02; no `p*.json` existed). The N=60 extension cannot be used: every eligible session on the machine is already a point (§B4). Its replacement, fixed now: if H2 or H8b is inconclusive at N=27 (CI straddling the bound), every arm is run a **second time on every point** (`BENCH_REPLICATE=2`) with the same vetted questions, the same judges and a different label shuffle, and the replicates are **averaged per point per arm** before any statistic is computed. The second replicate is never read on its own and never used to swap a point. Replication tightens within-point noise (answer sampling, judge variance) but not between-point variance, so the bound may still not be reached; the hypothesis is then published as inconclusive with the implied n. Only H2 and H8b trigger it; every other hypothesis is re-scored on the averaged data as a consequence, never as a reason.


### B3. Arms

Every arm uses the **same answering model** (`claude-opus-5-5`), the same
tool allow-list, and a copy of the transcript that **stops at the cut**, so
nothing after it is reachable. Every arm runs through its own eunoe proxy
instance (native through a passthrough one), so context size, cache traffic
and lookups are logged identically.

Every arm also runs in the **same Claude Code environment people actually
use**: the default system prompt, the user's `CLAUDE.md` files, installed
skills and plugins, loaded the normal way (no `--bare`). MCP servers are off
for every arm alike, because they would make runs depend on outside services.
eunoe never edits the system prompt or the tool list, so these must be
identical across arms; the proxies log a hash of both on every request and §B6
checks it.

| arm | what the agent gets | isolates |
|---|---|---|
| `native` | Claude Code's compaction as shipped. Real points: the summary it produced at the time. Synthetic: a genuine `/compact` on a copy. | the thing being replaced |
| `native+guide` | identical to `native`, plus the same transcript-search instructions eunoe gets | H3 |
| `tail` | first message + most recent whole turns, oldest dropped until it fits **the same budget rule eunoe uses**. No reduction, no summary. In practice ~2× eunoe's tokens. | H2 |
| `eunoe` | the cut: first message, every earlier turn as prompt + final reply, live turn whole; markdown transcript | the system |
| `rolling` | the hybrid: the last 3 finished turns whole, every older turn as prompt + final reply, live turn whole. Measured right after a step, the least recent detail it ever holds (§B3.1). | H8 |
| `trim` | every finished turn already reduced, all session long | the cheap variant |
| `full` | no compaction at all (where the history fits in 1M) | the ceiling and the per-point difficulty gate (§B6) |

#### 3.1 `rolling`, the hybrid

`trim` loses the previous turn's tool output the moment a new turn starts;
`eunoe` keeps everything until the window fills, then keeps nothing older than
the live turn. `rolling` sits between them: recent turns keep their full
detail, older ones shrink to prompt + final reply.

The naive version folds the oldest kept turn on every new turn. That changes
the request partway through every time, so everything after the change is
written to the cache again each turn. `rolling` moves its cut in **steps**
instead: older turns keep their detail until **100k tokens** of it have built
up, then everything but the last **3** finished turns shrinks at once. Between
steps the request only grows at the end, the same cache pattern as `eunoe`;
the price is one rewrite of the recent turns per step, not one per turn. The
full-window cut still applies as a backstop.

Implemented as `eval.rolling: { keep: 3, budget: 100000 }` in
`src/proxy/compaction.ts`; both values are fixed here and not tuned on these
points. In this benchmark the arm is measured **right after a step** (the cut
forced at `live − 3`), when it holds the least recent detail of its cycle, so
its scores are a lower bound for what it delivers live.

**Dropped on purpose:** XML / qmd / JSONL transcript variants (bench2 put them
within noise of markdown; ranking them needs ~300 points) and "last 5 turns
only" (bench2 settled it at −6.4% vs keep-all). Fewer arms, more points.

Agent runs: recall 7 × 27 = **189** (`full` only where the history fits);
continuation 6 × 20 = **120** (`full` excluded there — it isn't a strategy
anyone could ship).

**Model and account.** Every call — generator, oracle, arms, judges — runs
through the Claude Code CLI on one Claude subscription account pinned by
`CLAUDE_CONFIG_DIR`, with the user's hooks disabled and MCP off, so no run
touches the live login. When that account is limited for 30 minutes, calls
fall back to API credits for an hour and then return to the subscription. The
arms always run `claude-opus-5-5`; Haiku is used nowhere, because a smaller
answering model would make the result about the model, not the context.


### B4. Cut points

**N = 40 was the target; the data supports 27.** From bench2's per-point
variance (sd ≈ 10 points of 100): H1 needs ~10, H2's 2-point non-inferiority
needs ~35–40, H5 is the noisiest and gets what 40 buys.

**Deviation, recorded 2026-10-08 before any arm ran:** applying the selection
rules below to every session on the machine (after removing the same session
listed under several config roots, and sessions with fewer than 20 user turns
before the cut) yields **19 real and 8 synthetic points, N = 27**. The
synthetic stratum ran short, so real points fill in. `points.json` fixes that
list; nothing is swapped afterwards. Consequences: H1, H4, H7, H9, H10 are
powered as planned; H2 and H8(b), the non-inferiority tests, will likely
report CIs wider than the ±2 bound and are then reported as inconclusive, not
as passes. The "extend to N=60" rule cannot be used. More points need
sessions from other developers (§B9).

| kind | count | native's context |
|---|---|---|
| real | 19 (target 20) | the summary Claude Code actually produced |
| synthetic | 8 (target 20) | a fresh `/compact` on a copy, cut where context first crossed 350k |

Half and half because bench2 hinted they differ (native scored lower on fresh
`/compact` than on its original summaries), and neither alone should carry
the result. Results are reported per stratum as well as pooled.

Selection, all mechanical, in `choosePoints()`:

- ≤ 3 points per project (14 projects available → no project exceeds 7.5%)
- ≥ 20 user turns before the cut
- ≥ 2 real user turns after the cut (continuation ground truth)
- project directory still on disk (tools must actually run)
- the list is written to `points.json` **before any arm runs**; no swapping afterwards


### B5. Measurement

#### Tier 1 — recall (all 40 points)

12 questions per point, generated from the **raw history with tool output for
every turn** — not from a digest shaped like what any arm keeps. bench2's
evidence audit found 33% of reference answers live only in tool output (which
eunoe drops) vs 19% only in prompts/replies (which it keeps); the quotas below
keep it that way deliberately.

| type | n | what it asks | why |
|---|---|---|---|
| `tool_evidence` | 3 | a value that appears **only** in tool output or a call — a printed value, a filename from a listing, an error string, an ID; ≥1 from >15 turns back | the material eunoe drops |
| `mid_history` | 2 | what was worked on 5–15 turns back and how it ended, named by topic | "what did we do about X" |
| `instruction` | 2 | a standing instruction given ≥5 turns back that a default agent would violate, **or one that was revised** (the answer is the revision) | bench2's easy version was 100% ceiling; this one has to bite |
| `decision` | 1 | what was decided, why, and an option that was rejected | native's weakest category |
| `continuation` | 2 | what was mid-flight and what comes next; what was promised but not done | the handoff |
| `recent` | 2 | a value **only** in tool output or a call from 1–3 turns before the cut, never the live turn | H8: what `trim` drops and `rolling` keeps |

Every question has a reference answer and `turnsAgo`. Scores are broken down
by distance from the cut, so decay is shown as a curve rather than asserted.

Scoring per answer: **2** correct and specific · **1** partial · **0** wrong,
missing, or declined. Judges also label each answer `correct` / `partial` /
`unknown` / `wrong`, so a confident fabrication (H4) is counted apart from an
honest "I don't know".

#### Transcript use (all points, H9)

Recall scores alone can't say *how* an arm got an answer: from what it kept,
or by searching the transcript. eunoe's design depends on the second, so it is
measured directly.

- **Needed a lookup.** A `tool_evidence` or `recent` question whose answer
  exists only in tool output from a turn the arm no longer holds whole:
  every such question for `eunoe` and `trim`; for `rolling`, those with
  `turnsAgo` > 3; for `tail`, those older than the turns it kept (logged by
  its proxy); never for `full`. Native is reported but not classified, since
  its summary may carry any value.
- **Found by lookup.** The reference answer (normalised, ≥ 3 characters)
  appears in tool output the agent read *after* the question was asked:
  mechanical, no judge.
- **Reported per arm:** lookup rate on needed questions, score when found vs
  not found, wrong-answer rate when it didn't search (guessing instead of
  looking), searches on questions that didn't need one (wasted effort), and
  tool calls and seconds per answer.

H9 passes if, for `eunoe`, the found rate on needed questions is ≥ 50% and
the per-point score on found questions exceeds the score on needed-but-not-
found ones (paired bootstrap as in §B7). Tier 1 prompts the agent that a
transcript may exist, so it measures whether it *can* search; Tier 2 never
mentions it, so every transcript read there is unprompted, and the count of
continuation turns that read the transcript before acting is reported per arm
as the measure of whether it *does*.

#### Skills and the system prompt (all points, H10)

A skill is loaded mid-session: its instructions arrive inside the turn that
invoked it, next to tool output. A strategy that drops a turn's middle drops
the skill with it, and the agent silently stops following it. eunoe keeps any
text loaded or sent during a turn (skill bodies, messages the user sent while
the agent worked) when it shrinks that turn to prompt + reply.

- **Skill retention (mechanical).** For each point, the skills loaded before
  the cut are listed from the raw history. Each arm's first request after the
  cut is checked for each skill's instructions. Reported as a rate per arm;
  H10 passes if eunoe, rolling and trim keep 100%.
- **Instruction following (judged).** The oracle's standing-instruction list
  for Tier 2 includes instructions that came from loaded skills and from
  `CLAUDE.md`, marked by source, so violations can be broken down by where the
  instruction came from.

Points with no skill loaded before the cut don't count toward H10; the number
that do is reported, and if it is under 10, H10 is reported as untested
rather than passed.

#### Tier 2 — continuation (20 points: the 10 real and 10 synthetic with the richest post-cut history)

Recall is a proxy. This is the thing.

For each point we have the **real next user message** and what the agent
**actually did** in response. Each arm receives that message and works **one
turn** in an isolated `git worktree` of the project, checked out at the commit
the session was on (from the transcript's recorded branch/commit; if absent,
current HEAD, flagged). Normal tools, with `git push`, deploys, package
publishing and anything outward-facing disallowed.

Judged, with the real agent's next turn as reference:

| metric | scale | how |
|---|---|---|
| **task fidelity** | 0–2 | did it do what the real continuation did, or something defensibly equivalent, given the same instruction? |
| **instruction violations** | count | before the run, the oracle extracts every standing instruction active at the cut (e.g. "don't commit", "use pnpm", "deploy to staging yourself"). The judge checks the turn against that list. |
| **redundant work** | count | did it redo something already completed before the cut (re-reading a file it had edited, re-running a fixed test, re-asking a settled question)? |
| **wall time, tool calls, tokens** | measured | cost of continuing |

The worktree diff and the full turn transcript are saved per arm per point and
published with the results.


### B6. Validity guards

| guard | what it prevents |
|---|---|
| **Oracle vetting before any arm runs.** A model holding the whole pre-cut history checks each question: is the reference answer actually supported? Rejected questions never cost an arm and never score. | broken questions and wrong reference answers |
| **`full` as the per-point difficulty gate.** If the no-compaction ceiling doesn't outscore native on a point, the questions didn't test compaction; that point is reported in a separate "non-discriminating" bucket and excluded from the headline. | easy points dragging every arm to 95% (bench2: 59% dead questions) |
| **Two judges from different families** (`claude-opus-5-5`, `claude-sonnet-5-5`), every answer. Agreement is reported; the mean is used. If exact agreement < 70%, the run is flagged and a third judge is added before publication. | measuring the judge instead of the arms |
| **Shuffled anonymous labels per point**; every arm is the same answering model. | label preference, self-preference asymmetry |
| **Transcript copy stops at the cut**; native's summary pointer is re-aimed at that copy. | future leakage |
| **Same system prompt and tools in every arm.** Each proxy logs a hash of both per request; a point where they differ between arms is re-run, and if it differs again, dropped and listed. | one arm silently running with different instructions or tools |
| **Infrastructure failures retry, never score zero** (usage limits, lost prompts). Prompts go through files, not pipes. | the 1% silent dropout seen in bench2 |
| **Per-project caps, half real / half synthetic, mechanical selection.** | one project or one cut type carrying the result |
| **Fixed random seed** for label shuffling; model IDs pinned; raw per-point JSON published. | irreproducibility |


### B7. Statistics

- Unit of analysis: the **point**. Per-point score = mean over its vetted questions.
- Each hypothesis: paired difference per point → mean, sd, 95% percentile bootstrap CI (20,000 resamples), and the 80%-power n implied by the observed sd.
- Non-inferiority (H2): CI lower bound ≥ −2 points of 20 (−10% of per-point score).
- H8 has two parts and passes only if both hold: (a) on the `recent` questions alone, the paired rolling − trim per-point difference has a CI above zero; (b) on all questions, rolling − eunoe meets the H2 non-inferiority bound. Part (a) rests on 2 questions per point, 80 in all; its observed sd and implied n are reported, and if the CI straddles zero it is reported as inconclusive, not as a fail.
- Reported alongside every headline: ceiling rate (perfect scores per arm), dead-question count, judge agreement, per-project and per-stratum breakdown, score by `turnsAgo` bucket, and **tokens per point per arm**.
- No hypothesis is added, removed or reworded after `points.json` exists.


### B8. Cost and run plan

Estimates from bench2's observed usage. Per point, recall tier: question
generation (~300k in) + oracle (~300k) + 7 arms (~200k each, mostly cache)
+ 2 judges (~30k each) ≈ **2M input tokens**, call it **$6–10 API-equivalent**
at Opus prices. Continuation adds 5 working turns per point, heavier:
**$10–15/point**.

| phase | calls | est. cost-equivalent | notes |
|---|---|---|---|
| 0. commit `SPEC.md` | — | — | pre-registration |
| 1. prepare: select points, generate + vet questions, extract instruction lists | ~120 | ~$60 | cheap; **review 5 points' questions by hand before continuing** |
| 2. recall arms, 40 points, 3 in parallel | 280 | ~$290 | resume-safe; stop and restart across limit windows |
| 2b. second replicate, only if §B2's amendment triggers | 189 | ~$200 | `BENCH_REPLICATE=2`; same questions, new label seed; averaged per point |
| 3. judges, both models | 80 | ~$30 | |
| 4. `real/validate.ts` → tables | 0 | 0 | offline; scores H1–H10, the `recent` subset, the lookup classification (§B5), the fingerprint and `full` gates (§B6), every pairwise arm comparison, and writes `results.md` |
| 5. continuation, 20 points (`real/continue.ts`) | 120 | ~$300 | worktrees; the expensive half |
| 6. continuation judging | 40 | ~$30 | inside `real/continue.ts` |
| 7. write results into README **without touching §B1–§B7** | 0 | 0 | |

On subscription limits this is roughly 3–4 session windows. Sonnet as the
second judge halves judging cost; using Sonnet as the *answering* model is not
acceptable — the arms must run the model people actually use.

**Harness, as run (2026-10-08).** `real/run.ts prepare` generates and vets
every point's questions and stops; `real/run.ts run` runs arms and judges,
reusing them. Labels are shuffled with a fixed seed per point. Each proxy logs
the hash of the system prompt and tool list **as Claude Code sent them**
(before eunoe's rewrite) and the skills present in what was sent, so the
fingerprint check compares the environment and the skill check compares the
rewrite. `real/continue.ts` is the continuation tier: it takes the 8 synthetic
points and the 12 real points with the most user turns after the cut, among
those whose project is a git repository; each arm works in its own detached
worktree at the last commit on the session's branch before the cut's
timestamp (HEAD, flagged, when the branch is gone), with absolute paths in its
history retargeted to the worktree; one turn, at most 60 agent turns, with
push, publish, deploy and PR commands denied. Uncommitted changes the real
session had at the time are not recoverable, which is a limitation of every
arm alike. The oracle's instruction list is extracted once per point from the
pre-cut history plus the project's and the user's `CLAUDE.md`, each
instruction tagged `user`, `skill` or `claude_md`. "Read the transcript before
acting" counts transcript reads that happen before the first non-read tool
call. `real/validate.ts` scores both tiers offline.


### B9. Limitations, stated upfront

- **One developer's sessions.** 14 projects, one coding style, one way of giving instructions. The cleanest fix is 10–20 points from other developers run as a separate stratum; if unavailable, this is the first line of the limitations section, not a footnote.
- **Memory tests are a proxy.** Tier 2 narrows the gap but is one turn, not a session.
- **LLM-generated questions and LLM judges.** Mitigated (oracle, dual judges, labels), not eliminated. A hand-written question set for a subset would be stronger and is the first thing to add if this gets traction.
- **Native's real-point summaries were produced by whatever Claude Code version was current at the time**, not today's. Synthetic points use today's `/compact`; reporting both strata separately is the control.
- **The answering model is also the judged model family.** Every arm shares it, so there is no asymmetry, but an Anthropic reviewer could reasonably ask for a non-Claude judge as a third opinion.


### B10. What gets published

- This file, unchanged from the commit before `points.json`.
- `points.json`, every per-point result JSON, every continuation diff and turn transcript.
- The `validate` output: hypothesis table with CIs, per-stratum and per-project tables, ceiling/dead/agreement diagnostics, tokens per arm.
- The README results section, which quotes the hypothesis table verbatim — passes and fails.

## Part C: component evals

Written 2026-10-09, after the planted suite's test run (`RESULTS.md`) and
before any component change was adopted. rolling+both reached 99% on the test split
with the agent's own transcript searches filling what the components missed.
This document measures the two components on their own, so they can be made
to carry that load without searches, and so a future change to either can be
checked in seconds without a model.

### C1. What each component does

**Evidence** runs when a turn is folded (rolling step, compact cut, trim). For
every tool call whose result cannot simply be re-run (anything but Read, Grep,
Glob, LS, Edit, Write and the like), its output is scanned line by line. A
line is a candidate if it matches an error pattern (error, failed, denied,
timed out, ENOENT-style codes, SIGxxx) or a value pattern (ids like
`dpl_x7…`, hex hashes of 7+, URLs, numbers of 4+ digits, timestamped names like
`20250616_shovul`, versions, durations and sizes, `sha256:…`, `@handles`,
`--flag=value`, test and diff summaries like `164 passed` or `50 files
changed`, currency). Candidates are scored: error +3, value +2, `key: value`
shape +1, under 120 characters +1, a label word such as id, hash, trace,
deployment, preview, url, rows, p95, exit code +1. Selection is turn-level:
every call keeps its best two lines, then the remaining budget goes to the
highest-scoring lines across the whole turn, at most 12 per call and 4,000
characters per turn, lines clipped at 220 characters. The kept lines are
quoted verbatim under the call that produced them.

**Recall** runs once per user message, on the first request of the turn,
before the agent responds. The corpus is every tool output no longer in
context, cut into 6-line windows and tagged with the call that produced it,
plus the agent's own narrative text from folded turns ("now checking the
router…"). Ranking is BM25 (k1 1.2, b 0.75) over the message's terms, with a
chunk needing at least two query terms. Each line of a multi-line message is
its own query. The top 12 chunks per query are rendered oldest first, showing
the lines that match the query (±1 line) plus any salient line in the chunk
(same patterns as evidence), up to 10 lines a chunk, within 18,000 characters
(30,000 for multi-line messages). The result is attached to that message and
reused on every later request of the thread, so the prompt cache is not
disturbed. There is no embedding, no vector index and no model: it is word
overlap, in memory, rebuilt per request from the messages on hand.

### C2. Ground truth

**Planted.** The 36 generated sessions carry 470 facts whose value lives in
tool output (tool_value, error, superseded, prose_value), each with the turn
it was printed in. For evidence the question is: after that turn folds, is
the value in the turn's `<tool-evidence>`? For recall: given the fact's own
question, is the value inside the injected `<recalled-context>`? Both are
exact string checks; no model is involved. Coverage is reported by fact type
and by distance from the cut.

**Real.** the real-session suite's 27 real points carry 270 vetted questions with LLM-written
answers. The answer's key tokens (terms of 6+ characters or containing a
digit) stand in for the value. Evidence: does any key token survive in the
evidence of the source turn (±1 turn, since `turnsAgo` is the question
writer's estimate)? Recall: does any key token appear in the injected
context? This is a weaker check, so real numbers are read as a trend next to
the planted ones, not as a score.

**Cost.** Evidence: mean and p95 characters per folded turn over every turn
of every session, and the share of eligible output kept. Recall: median
injected characters per message.

### C3. Selection rule

A variant is adopted when it raises planted coverage without lowering real
coverage, at a cost that stays under roughly 1,000 characters per folded turn
(evidence) or 5,000 per message (recall). Ties go to the cheaper variant. The
adopted settings become the defaults in `src/context/constants.ts`; the
previous defaults stay in the evals as `v1` so the gain is always visible.

Adopting a component change does not change a published result: rolling+both
on the test split stands as run. The new defaults are a new frozen
configuration, `rolling+both2`, run on the dev split first and on the test
split once, and reported next to the original.

### C4. Variants tried

Evidence: per-call line caps 4/8/12 with turn budgets 1.6k/3.2k/4k/6k;
scanning the first 400 lines or all; minimum score 3 or 2; including
re-readable tools; turn-level ranked selection with and without label words;
a per-call floor of 0/2/4 lines.

Recall: top 2/4/8/12 chunks per query; minimum 1 or 2 matched terms; 6, 12 or
24-line windows; indexing the agent's narrative text; salient lines in the
excerpt; weighting the call description 1–3×; a model reranker (Haiku 4.5
picks ≤4 of BM25's top 30).

### C5. Round 2: models (pre-registered 2026-10-08, before any result)


Both components are now measured against model-based and index-based
alternatives, on the same ground truth as §C2, with the same exact-match hit.
Scripts: `evals/retrieval.ts` (recall rankers), `evals/evidence-models.ts`
(fold-time line pickers). Local models run through transformers.js (ONNX, in
the Bun process, no server) and ollama; hosted ones through the API.

**Recall arms.** All share the adopted corpus (6-line windows plus agent
narrative) and the adopted rendering (top 12, salient excerpt), so only the
ranking differs.

- `bm25` (adopted; min 2 matched terms) and `bm25 min1`.
- Dense retrieval with a local embedding index: all-MiniLM-L6-v2, bge-small
  and bge-base (v1.5), e5-small-v2, gte-small, nomic-embed-text-v1.5. Chunk
  text = call description + lines, cosine over normalised vectors, the index
  built once per corpus and cached on disk.
- Hybrid: reciprocal-rank fusion of BM25 and each dense ranker.
- Local cross-encoder rerankers over BM25's top 30: ms-marco-MiniLM-L-6-v2,
  bge-reranker-base, mxbai-rerank-xsmall; one also over the best hybrid.
- Hosted rerankers over the top 30: Haiku 4.5 and Sonnet 5.5 pick ≤4; Haiku
  also over the best hybrid. Haiku query rewriting (question → likely log
  terms) feeding BM25.
- Local LLM rerankers via ollama (3B class) with the same prompt.

Reported per arm: hit rate inside the injected context (planted by fact type,
real by question type), whether the answer is anywhere in the top 12 and the
top 30 (ranking quality apart from rendering), ms per query (median, p95),
injected characters, index build time per 1k chunks, model calls and tokens.

**Evidence arms.** Evaluated on every turn that holds a planted value and on
the source turns of real tool-output questions. The model sees each eligible
command's output numbered by line (first and last 200 lines when longer) and
returns line numbers, ≤12 per command, rendered in the same `<tool-evidence>`
shape as the pattern scorer.

- `patterns` (adopted).
- Haiku picks; Haiku picks ∪ the pattern scorer's top 4 per command.
- Haiku notes: free-text fact list instead of verbatim lines (scored the same
  way, so paraphrase counts as a miss).
- Local LLM picks via ollama, alone and ∪ patterns.

Reported: coverage (planted by type, real), characters per folded turn,
calls, tokens, ms per turn.

**Selection rule.** As §C3, with latency added: a recall arm is adopted only
if it raises planted and real hit rate by at least 2 points each over the
adopted BM25 and adds under 300 ms median per user message on this machine;
an evidence arm only if it raises real coverage by at least 5 points without
lowering planted coverage, at under 1,500 characters per folded turn. A fold
happens about twice a session, so evidence may spend a model call; recall
runs on every message, so it may not add a hosted call unless the gain is
large (≥5 points on both). Any adopted arm becomes `rolling+both3` and is run
end to end on dev and once on test, like `rolling+both2`.

## Part D: amendments and corrections

Every change to a frozen section, dated, in order. Nothing above was edited
after its run started; this is where the record lives.

### Planted suite

**2026-10-08, scoring of stale values (dev split only; test split not yet run).**
The original rule marked any reply containing a superseded value as wrong,
even when the value was named as the old one ("`yalsho/`, which replaced
`pennix/`"). That penalises arms that remember the history of a rule. A stale
value now counts against a reply only when it is used unframed: not preceded
within ~50 characters by a supersession marker (old, previous, replaced,
instead of, rather than, not, was, …) and not followed by one (no longer,
retired, replaced, …). The rule lives in `usesUnframed` in `planted/run.ts`;
`planted/report.ts` rescores every stored reply and answer with it, for every arm.
On the dev split it changed 74 verdicts, all wrong → correct, spread across
all twelve arms (3–10 each); each one was read by hand and each named the
stale value only as the replaced one. Found while reading why eunoe missed
tasks native got; fixed before any test-split run.

**2026-10-08, after dev, before test: the tie-break.** §A6's tie-break reads "lowest worst-bucket accuracy"; it means the arm whose
worst bucket (any depth bucket or fact type) is highest. Applied that way to
pick the runner-up. The frozen choice is in `results/planted-frozen.md`.

**2026-10-08, after the test run: the `full` arm was cut.** The runner sent every arm an `x-eunoe-window` header sized so the eunoe arms
cut at the end of the session. The proxy trusts that header over its own
config, so the `full` arm, which shares the `observe` proxy with `native`,
was cut there too: every earlier turn reduced to prompt and reply, about 120k
tokens at recall instead of the whole session. Its first results (95% recall
on test, 97% on dev) measured an unaided eunoe cut, not the full history,
and are kept in `runs/{dev,test}/invalid-full/` for the record. `native`
was not affected: its compacted session never reached the threshold.

Fix: arms marked `uncut` (`native`, `full`) no longer get the window header
(`arms.ts`, `planted/run.ts`). `full` was rerun on both splits. The uncut session is
about 480k tokens at recall on s01 and fits the answering model's window.
No method code changed; P6 is judged against the rerun.

### Component evals

**2026-10-09, pattern regression suite.**

`test/evidence-patterns.test.ts` pins one real-looking line per pattern class
(37 must-keep, 14 must-drop) so a dropped match fails `bun test`. On its first
run it found six gaps: bare `FAIL`, errno codes (`ENOENT`), binary sizes
(`KiB`/`MiB`), timestamped names with underscores (`20250616_add_leases`),
HTTP status lines and exit codes. Fixing them exposed a ranking flaw: in long
logs every line scores the same on a timestamp, so the one line holding an
identifier lost on position. Identifiers (`dpl_…`, `req_…`, hashes, URLs,
versions, scoped packages) now score 3 against 2 for plain numbers.

Component evals after the change, all 36 sessions: evidence planted 97%
(tool_value 95→96, prose 96→98), real 77→78; recall 91/91 unchanged. End to
end numbers were not rerun; the change is to ranking inside a budget the
frozen run already met.
