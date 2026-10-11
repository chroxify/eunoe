# Handoff suite

Measures the cold start: a fresh Claude Code session that has to continue
work an earlier session did. `SPEC.md` is the pre-registered design; this
file is how to run it. It reuses the planted sessions and their exact-match
scoring, so it needs the planted suite's `out/planted/sessions` and
`out/planted/canon` to exist.

```sh
export BENCH_CLAUDE_CONFIG_DIR=~/.claude-swap-backup/sessions/<account>   # the bench account

bun bench/handoff/prepare.ts --split=dev          # resume prompts + every injection, cached under out/handoff
bun bench/handoff/run.ts --split=dev --tag=dev    # every arm × scenario on the dev split
bun bench/handoff/report.ts --tag=dev --split=dev # tables + C1–C5
bun bench/handoff/select.ts --split=dev           # the selection tier (C6)
```

`run.ts` skips finished runs, so a stopped run resumes with the same command.
`--arms`, `--scenarios` and `--sessions` narrow a run; `--parallel` is
sessions in flight (arms within a session run concurrently).

## Files

| file | role |
|---|---|
| `arms.ts` | the arms (what a fresh session gets) and the three proxies that carry them |
| `prepare.ts` | resume prompts (Opus, in the developer's style, no planted values) and injections: full transcript, folded view, capped folded view, rules, briefs |
| `run.ts` | fresh session → resume prompt → tasks → recall, scored by the planted suite's `verdict` |
| `report.ts` | per-arm, per-scenario and per-fact-type tables, paired CIs against `cold`, hypotheses |
| `select.ts` | which session to hand off from: recency, bm25, bm25 over the folded view, e5, Jev |

## How the arms reach the fresh session

Every arm sends `x-eunoe-canonical` so the fresh session gets the same system
prompt and tools as the other suites, and `cold+hint` sends
`x-eunoe-transcript` so the one-line hint names a real file. The `agent*`
arms need nothing else: the fresh session's system prompt teaches `eunoe
sessions`, `eunoe load` and `eunoe peek` (`AGENT_SECTIONS` in
`constants.ts`), and the agent runs the CLI in `bin/` itself.

The injection and cross-session recall arms (`full`, `folded*`, `rules`,
`brief-*`, `*recall*`, `auto*`, `multi*`) send `x-eunoe-handoff-file` and
`x-eunoe-handoff-source`. Those headers were honoured by an experimental
proxy build that put the file into a `<handoff>` block on the first prompt
and indexed the source session for recall. The suite's result was to ship
the manual route instead, so that build was never committed and the shipped
proxy ignores the headers: those arms cannot be rerun against this tree, and
their numbers in `results/handoff-test.md` are the record.
