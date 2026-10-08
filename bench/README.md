# eunoe benchmark

One rerunnable evaluation of context strategies for Claude Code. It answers a
single question: when a long session runs out of context, which strategy
leaves the agent knowing more, and which of its parts carry that? Two suites
answer it end to end, a set of component evals answer it for the parts, and
every number in `RESULTS.md` comes from a table in `results/`.

| | |
|---|---|
| `SPEC.md` | The pre-registered design: planted suite (A), real-session suite (B), component evals (C), and the dated log of every change (D). Read first. |
| `RESULTS.md` | The report against the spec: headline, every arm, every component, corrections, limits, decision. |
| `results/` | The reviewed tables the report quotes. Committed. |
| `arms.ts` | Every strategy under test as an eunoe `config.json`. Both suites share it. |
| `planted/` | **Planted-fact suite.** 36 generated sessions of 90–120 turns on real repos with 25 facts each hidden at known depths; exact-match scoring, no judge; a dev split to choose a method and a held-out test split to confirm it. The decisive suite. |
| `real/` | **Real-session suite.** 27 cut points from one developer's own sessions, LLM-written questions vetted by an oracle, two judges, a continuation tier in git worktrees. The generalisation check. |
| `evals/` | Evidence pickers and recall rankers scored in isolation (patterns, Haiku, Jev, local models, BM25, embedders, cross-encoders) and the fold-budget simulation. Seconds to minutes, mostly no model. |
| `lib/` | Shared plumbing: the Claude CLI runner with account pinning and credit fallback, proxy spawning, session-file helpers, data loaders, Jev client, JSON extraction, a detacher. |
| `tools/` | Instruments used to find confounds (the system-prompt switch on resume, fingerprint diffs) and the embedder dependencies for the retrieval matrix. |
| `out/` | Raw outputs. Git-ignored: it holds real session transcripts and repository code. |

## Headline

Held-out test split, 24 sessions, 600 planted facts, Sonnet answering:

| arm | recall | instructions applied unprompted | context at the question | tokens / session |
|---|---|---|---|---|
| Claude Code `/compact` | 70% | 92% | 70k | 741k |
| no cut at all (ceiling) | 100% | 90% | 411k | 815k |
| **eunoe default** (rolling + evidence + Jev-reranked recall) | **99%** | **95%** | **110k** | **305k** |

+29 points over native, better on 12 sessions and worse on none; the same
+29 margin on the 27 real sessions. Every interval and caveat is in
`RESULTS.md`.

## Setup

- Bun, the Claude Code CLI, and this checkout (arms run `src/cli/main.ts serve`
  on their own ports, 8810–8829).
- One Claude account for the whole run: `export BENCH_CLAUDE_CONFIG_DIR=<config dir>`.
  Every call goes through it with hooks disabled and MCP off, so the live
  login is never touched. Without it the runner uses `~/.claude`.
- Optional: an API key in `~/.config/eunoe-bench/api-key`. After the account
  has been rate-limited for 30 minutes, calls use the key for an hour, then
  return.
- Optional: a Typesafe key in `~/.eunoe/typesafe-key` for the Jev arms.
- For the retrieval matrix only: `cd bench/tools/models && bun install`
  (transformers.js and the ONNX runtime, ~3 GB).

Every phase is resume-safe: an output that exists is skipped, so a phase can
stop at a usage limit and be restarted. Long phases should run detached:
`python3 bench/lib/detach.py <log> <command...>`.

## Planted suite

```sh
bun bench/planted/generate.ts 36 18                  # sessions s00–s35 (Opus; hours; --only=6,7 to redo some)
bun bench/planted/smoke.ts                           # a 5-turn fixed session for a one-minute pipeline check
bun bench/planted/run.ts --split=smoke --tag=smoke --arms=native,default --parallel=1

bun bench/planted/run.ts --split=dev --tag=dev       # every baseline arm on the dev split (Sonnet)
bun bench/planted/run.ts --split=dev --tag=dev --arms=rolling+both,default
bun bench/planted/report.ts --tag=dev --split=dev    # accuracy by type and depth, paired vs native, cost

bun bench/planted/run.ts --split=test --tag=test --arms=native,native+guide,full,default
bun bench/planted/report.ts --tag=test --split=test
```

`out/planted/` holds `sessions/sNN.{jsonl,meta.json,turns.json}`, `native/`
(Claude Code's `/compact` of each session, made once and reused), `canon/`
(the system prompt and tools every arm is given), and `runs/<tag>/` with one
JSON per session and arm plus `report.<split>.md`.

## Real-session suite

```sh
bun bench/real/run.ts points                         # select points → out/real/points.json, run nothing
bun bench/real/run.ts prepare 27 3                   # generate + vet 12 questions per point (3 in parallel)
BENCH_TAG=v0.2 BENCH_ARMS=native,native+guide,default bun bench/real/run.ts run 27 3
bun bench/real/report.ts v0.2                        # recall per arm, type and depth; paired vs native
bun bench/real/continue.ts 20 2                      # tier 2: replay the real next message in worktrees
bun bench/real/validate.ts                           # score both tiers against the hypotheses in SPEC B2
```

Review a few points' `pNN.questions.json` by hand between `prepare` and `run`;
the oracle rejects unsupported questions, but it is a model. Record the
environment next to the outputs: `{ git rev-parse HEAD; claude --version; bun --version; } > bench/out/real/env.txt`.

## Component evals

```sh
bun bench/evals/evidence.ts [dev|test]               # pattern variants: planted coverage by type and depth, real, chars per turn
bun bench/evals/recall.ts [dev|test]                 # BM25 variants: hit rate inside the injected context
bun bench/evals/retrieval.ts dev                     # the ranker matrix: bm25, dense, hybrid, cross-encoders, Haiku/Sonnet/Jev rerank
bun bench/evals/evidence-models.ts dev               # model line pickers vs patterns (Haiku, Jev, ollama)
bun bench/evals/rerank.ts dev                        # the round-1 Haiku reranker
bun bench/evals/budget.ts 3                          # fold frequency and peak context per budget, keep 3
```

Outputs go to `out/evals/`. `retrieval.ts` and `evidence-models.ts` take
`EVIDENCE_ARMS` / arm filters and `OLLAMA_MODELS` to run a subset; model
picks are cached per turn so a restart resumes.

## Rerunning on a new eunoe version

The generated sessions, their native compactions, the real points and their
vetted questions are the fixed exam. Keep them, run the arms under a new tag,
and compare reports arm by arm:

```sh
bun bench/planted/run.ts --split=test --tag=v0.3 --arms=native,default
bun bench/planted/report.ts --tag=v0.3 --split=test
BENCH_TAG=v0.3 BENCH_ARMS=native,default bun bench/real/run.ts run 27 3 && bun bench/real/report.ts v0.3
```

A run on regenerated sessions or questions is a new benchmark, not a rerun.
`real/run.ts` refuses to run if the sessions on disk no longer reproduce
`points.json`.

## Adding a method

Every arm is an eunoe `config.json`, so any mode, tunable or `eval` knob is
an arm. Add it to `arms.ts` with its own proxy name and port, develop on the
dev split, run the test split once for a frozen configuration and record
which one (SPEC A3). Write a hypothesis into the spec before running and let
the scorer report against it. For a component change, run the eval in
`evals/` first; a change that does not move the component table has no
business in an end-to-end run.

## Publishing

`out/` stays private: the transcripts are real sessions. What leaves the
machine is `SPEC.md`, `RESULTS.md`, `results/`, and, per SPEC B10, the
per-point JSON and continuation diffs after a review, since they quote
session content in questions and answers.
