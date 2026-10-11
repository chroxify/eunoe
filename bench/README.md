<div align="center">

# eunoe benchmark

**One rerunnable evaluation of context strategies for Claude Code.**

The design was written down before any arm ran, the method was chosen on one
split and frozen before the other was touched, and every number quoted
anywhere in this repository traces back to a table in this folder.

</div>

---

## The question

When a long Claude Code session runs out of context, Claude Code replaces the
conversation with a summary, and whatever the summary left out is gone. eunoe
folds finished turns instead, keeps the output lines that mattered and brings
old detail back when a message is about it.

The benchmark asks three things of that design. Does the agent remember more
of the session afterwards? At what size of prompt, and at what cost in tokens
and time? And which of the parts does the remembering, so that each one can
be changed later and checked in seconds rather than hours?

Measuring this honestly is harder than it sounds. A question written by a
model that has read the session asks about what is memorable, and a summary
keeps exactly that, so every strategy crowds the ceiling. The decisive suite
here plants facts a summary drops, with ground truth that exists before any
model is involved.

## Results

Measured on 24 held-out sessions of 90 to 120 turns on 12 real repositories,
with 600 facts planted at known depths and scored by exact match with no
judge involved. The method was chosen on a separate development split and
frozen before this split ran.

> These numbers come from one developer's repositories, one answering model
> and a single run per arm. They are a careful measurement, not a general
> one, and the limits are spelled out below.

| | facts remembered | rules followed without a reminder | prompt size when asked | tokens per session | transcript lookups per session | time per session |
|---|---|---|---|---|---|---|
| Claude Code's compaction | 70% | 92% | 70k | 741k | 10.1 | 53s |
| Claude Code, told a transcript exists | 99% | 92% | 71k | 1,315k | 23.0 | 88s |
| keeping the whole history | 100% | 90% | 411k | 815k | 0 | 67s |
| eunoe, frozen v1 | 99% | 92% | 118k | 490k | 2.7 | 40s |
| **eunoe** | **99%** | **95%** | **110k** | **305k** | **0.1** | **39s** |

*Facts remembered* is how many of the planted facts the agent could still
answer correctly after the cut. *Rules followed without a reminder* is how
often it applied a standing instruction from earlier in the session when a
task called for it, without being told again. *Prompt size* is the context
the model was reading when the question came, and *tokens per session* adds
up every request it took to answer all 25, so it grows whenever the agent has
to go and look something up.

That is **29 points more recall than Claude Code's compaction** (95% CI +17
to +42), better on 12 sessions and worse on none, with 1 unknown and 3 wrong
answers out of 600. All six pre-registered hypotheses pass. The worst single
bucket of fact type or depth is 99%, where native's is 50%.

The same margin holds on real work. On 27 cut points taken from one
developer's own sessions, with 318 model-written questions vetted by an
oracle and graded by two judges, eunoe's frozen v1 scored 89% to native's
60%, a paired difference of +29 (95% CI +21 to +37). Its gain over native
was largest exactly where a summary is weakest: 94% against 33% on facts
from the last three turns before the cut, and 91% against 55% on decisions.

Every interval, bucket and correction is in [`RESULTS.md`](RESULTS.md). The
tables it quotes are in [`results/`](results/).

### Which parts do the work

eunoe does three things, and each was measured alone before it was kept. The
table says what each adopted choice beat and where the full matrix lives.

| part | adopted | what it beat | table |
|---|---|---|---|
| **fold** | rolling: the last 3 turns whole, older turns folded in one step per 100k tokens of detail | one fold at the window (`compact`), a fold of every finished turn (`trim`), keeping only the last N turns (`tail`) | `RESULTS.md` §4 |
| **evidence** | a pattern scorer that keeps 97% of planted values at 0 ms | Haiku, Jev and local 3B models picking lines, alone or added to the patterns; every one traded 3 to 8 planted points for its real-session gain | `results/evidence-models.md` |
| **recall** | BM25 reordered by Jev: 95% planted, 95% real, 292 ms | BM25 alone (88 / 91), six dense embedders, four hybrids, three cross-encoders, Haiku and Sonnet rerankers, Haiku query rewriting | `results/retrieval.md` |
| **budget** | 100k tokens: a fold every ~38 turns, peak context 114k | 50k, 200k and 300k; quality is bounded by whole-versus-folded at 100 to 99, so the budget is a cost choice | `RESULTS.md` §5 |

The surprising part is not that eunoe remembers more, it is how. Telling
Claude Code that a transcript exists gets it to 99% too, but it has to grep
for the answer 23 times a session to do it, which is why it burns four times
the tokens. eunoe reaches the same 99% with one lookup every ten sessions,
because the answer is already in the prompt when the question arrives.

## How it is measured

### The planted suite

Opus writes 36 sessions of 90 to 120 turns on 12 real repositories, three
per repository, from an outline that code has already filled with 25 facts
drawn from a seeded random generator: ids, hashes, codes and names that
cannot be guessed. Each fact has a type that decides where it may appear and
a depth that decides how far before the cut it lands, so every distance
bucket gets about five.

```
type          where it lives                                           count
-----------   ------------------------------------------------------   -----
tool_value    one command's output, never repeated in prose              6
prose_value   a command's output and the agent's reply                   3
error         a failed command's output, never quoted                    2
instruction   a standing rule in one developer message                   4
revised       a rule given, then changed 8 to 25 turns later             3
superseded    a value printed twice; the later one is current            2
decision      two named approaches, one rejected, in a reply             3
promise       a rename deferred and never done                           2
```

Read-only steps run on the real repository, so most tokens are genuine code.
Code checks that every value appears exactly where the plan puts it and
nowhere else, and that no question gives away its answer. A session is sized
so the cut lands at a realistic 300 to 500k tokens.

Every arm then resumes the same session through its own proxy with the same
answering model and gets two messages: one task per instruction that can
only be done right by applying the rule, and one question per fact whose
answer is an exact value. Scoring is exact match after normalisation, with
four verdicts: correct, stale (the old value of a revised fact), unknown, and
wrong. Sessions whose index divides by three are the development split; the
other 24 are held out and run once per frozen configuration.

### The real-session suite

The generalisation check. 27 cut points are chosen mechanically from one
developer's own sessions: at most three per project, at least 20 turns
before the cut and two after, the project still on disk. 19 use the summary
Claude Code actually produced; 8 are a fresh `/compact` on a copy, cut where
the context first crossed 350k. Opus writes 12 questions per point, an
oracle with the full session rejects any it cannot support, and two judges
grade each answer. A second tier replays the developer's real next message
in a git worktree and judges the continuation.

### The component evals

Evidence and recall scored in isolation on the development split, exact
match, with the same corpus and rendering the proxy uses. The evidence eval
asks whether a planted value survives in the lines kept for its turn; the
recall eval asks whether it lands inside the context injected for its own
question. Most variants run without a model in seconds, which is what makes
a change to either component checkable before it earns an end-to-end run.

### Arms

An arm is an eunoe `config.json`. The `eval` block in the config exists for
this: `strategy` picks a baseline fold (`trim`, `tail` or `guide`),
`forceCut` and `rolling` make the fold happen at a known point, `evidence`
and `recall` switch those parts on and off, and `rerank` names the model
that reorders recall. The shipped `default` mode is the arm `rolling+both3`
with those knobs at their production values. Every arm runs its own proxy on
its own port, 8810 to 8831, so a run can spread arms across processes.

## Running it

### Setup

- [Bun](https://bun.sh), the Claude Code CLI and this checkout. Arms run
  `src/cli/main.ts serve` on their own ports.
- **One Claude account for the whole run.** `export BENCH_CLAUDE_CONFIG_DIR=<dir>`
  points every call at it with hooks disabled and MCP off, so your live
  login is never touched. Without it the runner uses `~/.claude`.
- **Optional API key** in `~/.config/eunoe-bench/api-key`. After the account
  has been rate-limited for 30 minutes, calls switch to the key for an hour
  and then return.
- **Optional Typesafe key** for the Jev arms. The proxies read
  `~/.eunoe/typesafe-key` or `TYPESAFE_API_KEY`; the component evals read
  `~/.config/eunoe-bench/typesafe-key` or the same variable.
- **For the retrieval matrix only,** `cd bench/tools/models && bun install`
  fetches transformers.js and the ONNX runtime, about 3 GB.

Every phase is resume-safe: an output that already exists is skipped, so a
phase can stop at a usage limit and be restarted with the same command. Long
phases should run detached, so a closed shell does not take them down:

```sh
python3 bench/lib/detach.py <logfile> <command...>
```

### Planted suite

```sh
bun bench/planted/generate.ts 36 18                  # sessions s00–s35 (Opus; hours; --only=6,7 redoes some)
bun bench/planted/smoke.ts                           # a 5-turn fixed session for a one-minute pipeline check
bun bench/planted/run.ts --split=smoke --tag=smoke --arms=native,default --parallel=1

bun bench/planted/run.ts --split=dev --tag=dev       # every arm on the dev split
bun bench/planted/run.ts --split=dev --tag=dev --arms=rolling+both3,default
bun bench/planted/report.ts --tag=dev --split=dev    # accuracy by type and depth, paired vs native, cost

bun bench/planted/run.ts --split=test --tag=test --arms=native,native+guide,full,default
bun bench/planted/report.ts --tag=test --split=test
```

`run.ts` takes `--split`, `--tag`, `--arms`, `--sessions` and `--parallel`.
`out/planted/` holds `sessions/sNN.{jsonl,meta.json,turns.json}`, `native/`
(Claude Code's `/compact` of each session, made once and reused), `canon/`
(the system prompt and tools every arm is given) and `runs/<tag>/` with one
JSON per session and arm plus `report.<split>.md`.

### Real-session suite

```sh
bun bench/real/run.ts points                         # select points → out/real/points.json, run nothing
bun bench/real/run.ts prepare 27 3                   # write and vet 12 questions per point, 3 in parallel
BENCH_TAG=v0.2 BENCH_ARMS=native,native+guide,default bun bench/real/run.ts run 27 3
bun bench/real/report.ts v0.2                        # recall per arm, type and depth; paired vs native
bun bench/real/continue.ts 20 2                      # tier 2: replay the real next message in worktrees
bun bench/real/validate.ts                           # score both tiers against the hypotheses in SPEC B2
```

Review a few points' `pNN.questions.json` by hand between `prepare` and
`run`: the oracle rejects unsupported questions, but it is a model. Record
the environment next to the outputs:

```sh
{ git rev-parse HEAD; claude --version; bun --version; } > bench/out/real/env.txt
```

`BENCH_TAG` names the run, `BENCH_ARMS` narrows it, `BENCH_ANSWER_MODEL`
sets the answering model and `BENCH_REPLICATE` repeats each point.

### Component evals

```sh
bun bench/evals/evidence.ts [dev|test]               # pattern variants: planted coverage by type and depth, real, chars per turn
bun bench/evals/recall.ts [dev|test]                 # BM25 variants: hit rate inside the injected context
bun bench/evals/retrieval.ts dev                     # the ranker matrix: bm25, dense, hybrid, cross-encoders, Haiku/Sonnet/Jev rerank
bun bench/evals/evidence-models.ts dev               # model line pickers vs patterns (Haiku, Jev, ollama)
bun bench/evals/rerank.ts dev                        # the round-1 Haiku reranker
bun bench/evals/budget.ts 3                          # fold frequency and peak context per budget, keep 3
```

Outputs go to `out/evals/`. Model picks are cached per turn, so a restart
resumes. A subset of arms or models runs faster:

| variable | script | effect |
|---|---|---|
| `RETRIEVAL_ARMS` | `retrieval.ts` | comma-separated rankers to run |
| `RETRIEVAL_PARAPHRASE` | `retrieval.ts` | score the Opus-paraphrased questions instead |
| `EVIDENCE_ARMS` | `evidence-models.ts` | comma-separated pickers to run |
| `OLLAMA_MODELS`, `JEV_MODELS` | `evidence-models.ts` | which local or Jev models to try |
| `RERANK_MODEL`, `RERANK_CANDIDATES` | `rerank.ts` | the round-1 reranker and its candidate count |

### Handoff suite

The cold start: a fresh Claude Code session continuing work an earlier
session did. It reuses the planted sessions and their scorer, so
`out/planted/sessions` and `out/planted/canon` must exist. Injecting the
earlier session's folded view and having the agent load it itself with
`eunoe load` both remember 98% of its facts and apply 95% of its rules; left
to pick the session on its own, the agent is wrong about a third of the time,
which is why only the manual route shipped. Its arms, how to run it and which
arms still run against this tree are in [`handoff/README.md`](handoff/README.md);
the pre-registered design is `handoff/SPEC.md` and the table is
`results/handoff-test.md`.

### Rerunning on a new eunoe version

The generated sessions, their native compactions, the real points and their
vetted questions are the fixed exam. Keep them, run the arms under a new tag
and compare reports arm by arm:

```sh
bun bench/planted/run.ts --split=test --tag=v0.3 --arms=native,default
bun bench/planted/report.ts --tag=v0.3 --split=test
BENCH_TAG=v0.3 BENCH_ARMS=native,default bun bench/real/run.ts run 27 3 && bun bench/real/report.ts v0.3
```

A run on regenerated sessions or questions is a new benchmark, not a rerun.
`real/run.ts` refuses to run if the sessions on disk no longer reproduce
`points.json`.

### Adding an arm

Add it to `constants.ts` with its own proxy name and port. Develop on the
development split, run the held-out split once for a frozen configuration
and record which one (SPEC A3). Write the hypothesis into the spec before
running and let the scorer report against it. For a change to one component,
run the matching eval first: a change that does not move the component table
has no business in an end-to-end run.

## What is in here

| | |
|---|---|
| `SPEC.md` | The pre-registered design: planted suite (A), real-session suite (B), component evals (C), dated amendments (D). Read first. |
| `RESULTS.md` | The report against the spec: headline, every arm, every component, corrections, limits, decision. |
| `results/` | The reviewed tables the report quotes. Committed. |
| `constants.ts`, `arms.ts` | Every arm as an eunoe `config.json`, with its proxy name and port. Both suites share them. |
| `planted/` | The planted-fact suite: generation, runs, exact-match scoring, report. |
| `real/` | The real-session suite: cut points, questions, runs, judges, continuation in worktrees. |
| `evals/` | The component evals: evidence pickers, recall rankers, the budget simulation. |
| `handoff/` | The handoff suite: the cold start, with its own README and spec. |
| `lib/` | Shared plumbing: the Claude CLI runner with account pinning and credit fallback, proxy spawning, session-file helpers, the Jev client, JSON extraction, a detacher. |
| `tools/` | Instruments used to find confounds (the system-prompt switch on resume, fingerprint diffs, a live `/compact` probe) and the embedder dependencies for the retrieval matrix. |
| `out/` | Raw outputs. Git-ignored: it holds real session transcripts and repository code. |

## What it doesn't show

- **One developer's repositories.** Every session, planted or real, comes
  from one machine. The honest test is many people's sessions, which is the
  contribution asked for below.
- **Generated sessions are not recorded ones.** The planted sessions were
  written by Opus from outlines, with real code read from real repositories
  but invented developer messages. The 27 real points cover that only
  partly.
- **One answering model, one run per arm.** The intervals are paired
  bootstraps across sessions, not across repeated runs.
- **eunoe does not out-recall the transcript hint.** Telling Claude Code
  that a transcript exists reaches the same 99%; eunoe matches it at a
  quarter of the tokens, a hundredth of the lookups and half the time.
  Instruction application ties native within noise.
- **Evidence on real sessions trails planted,** 71 to 80% against 97%,
  because real answers are often plain lines no pattern should keep. Jev
  recall covers that gap end to end; the patterns alone do not.

## Accounts

Every Claude call runs on the account in `BENCH_CLAUDE_CONFIG_DIR`.
`BENCH_CSWAP_ACCOUNT` names it for the `cswap` account switcher and
`BENCH_CSWAP_ROTATE=1,2` lets the handoff suite fall back to another account
when that one is limited, chosen once per run, because `--resume` only works
on the account that opened the session. The planted and real suites resume a
session file copied under the pinned account's config directory, so they
never rotate.

## What gets published

`out/` stays private: the transcripts are real sessions and the generated
ones embed real repository code. What leaves the machine is `SPEC.md`,
`RESULTS.md`, `results/` and, per SPEC B10, the per-point JSON and
continuation diffs after a review, since they quote session content in
questions and answers.

## Contributing a run

Context management is hard to benchmark well alone, because the honest test
is many people's real sessions. If you run the real-session suite on your
own history, find a case where eunoe does worse, or have a better way to
measure this, please open an issue or a pull request with the report and
`env.txt`. Results from other setups are the contribution I'd value most.
