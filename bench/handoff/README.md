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

## How the proxy takes part

Two trusted headers, honoured only when the proxy runs with
`eval.trustHeaders`: `x-eunoe-handoff-file` names a file whose text is put
into a `<handoff>` block on the fresh session's first prompt, and
`x-eunoe-handoff-source` names a session file whose dropped output and
narrative join the recall index, labelled as the previous session. The code is
`src/context/handoff.ts` and the `handoff` branch of `src/proxy/rewrite.ts`.
