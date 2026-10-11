# Handoff suite: held-out test split

2026-10-09. 24 source sessions × 3 scenarios (`bug`, `continue`, `rules`),
72 fresh sessions per arm. A fresh Claude Code session starts in the
repository, gets a resume prompt written by Opus from the source session's
outline (never quoting a planted value), then the source session's tasks and
recall questions, scored exactly as the planted suite does. Answering model
`claude-sonnet-5-5`. Design in `handoff/SPEC.md`; the injection arms ran
against an experimental proxy build that honoured `x-eunoe-handoff-*`
headers and was never committed (see `handoff/README.md`).

## Mechanisms

| arm | what the fresh session gets | facts remembered | rules applied | unknown | wrong | prompt at tasks | tokens per run | lookups | opening s |
|---|---|---|---|---|---|---|---|---|---|
| cold | nothing | 0% | 0% | 100% | 0% | 64k | 608k | 0.0 | 34 |
| cold+hint | one line: a transcript exists, search it | 96% | 20% | 3% | 2% | 72k | 1,846k | 22.3 | 40 |
| full | the whole source transcript injected | 99% | 93% | 0% | 1% | 362k | 3,353k | 0.5 | 43 |
| **folded** | the source session's folded view injected | **98%** | **95%** | 1% | 1% | 129k | 1,274k | 0.4 | 37 |
| folded+recall | folded view, plus cross-session recall | 98% | 94% | 1% | 1% | 140k | 1,258k | 0.4 | 33 |
| brief-opus+recall+ | an Opus-written brief, plus wide recall | 96% | 93% | 3% | 1% | 65k | 549k | 0.0 | 29 |

Paired against `cold` per fresh session, 95% bootstrap CI: cold+hint +95.5
[+91.1, +98.4]; full +99.3 [+98.9, +99.7]; folded +97.9 [+97.0, +98.6];
folded+recall +97.9 [+97.0, +98.6]; brief-opus+recall+ +95.7 [+92.0, +97.6].
Every arm beat cold on every session.

By scenario, facts remembered: folded 98 / 98 / 98, folded+recall 98 / 98 /
98, brief-opus+recall+ 96 / 93 / 98, cold+hint 94 / 94 / 99 (bug / continue
/ rules). By fact type, folded's weakest is `tool_value` at 94%; every other
type is 98 to 100%.

Pre-registered hypotheses (`handoff/SPEC.md` §6) for the winner `folded`:
C1 every arm beats cold, **pass**; C2 ≥ 90% remembered, **pass** (98%); C3
rules no worse than the in-session default, 95% against 95%
(`planted-test.md`); C4 prompt ≤ 25% of full, **fail** (129k vs 362k); C5
recall arms need fewer lookups than cold+hint, **pass** (0.4 and 0.0 vs
22.3).

## The agent loading the session itself

The shipped route: the fresh session's system prompt teaches `eunoe
sessions`, `eunoe load` and `eunoe peek`, and the agent runs them. `manual`
means the user's message names the session to load; `auto` means the agent
decides whether and which. A fourth scenario, `new`, is unrelated work where
any load is unnecessary. *Right session* is the share of runs where every
session the agent loaded was the source.

| arm | scenario | facts | rules | pulled | right session | commands per run | tokens per run |
|---|---|---|---|---|---|---|---|
| **agent, told which session** | bug | **98%** | **96%** | 100% | 100% | 1.0 | 1,316k |
| | continue | 98% | 95% | 100% | 100% | 1.0 | 1,083k |
| | rules | 98% | 95% | 100% | 100% | 1.0 | 1,463k |
| | new | – | – | 100% | 100% | 1.0 | – |
| agent, choosing on its own | bug | 33% | 33% | 58% | 71% | 1.6 | 1,193k |
| | continue | 86% | 85% | 100% | 71% | 2.6 | 1,235k |
| | rules | 53% | 53% | 88% | 48% | 2.8 | 1,092k |
| | new | – | – | 0% | – | 0.2 | – |
| proxy picks and injects (`auto`) | bug | 88% | 85% | – | – | – | 947k |
| | continue | 90% | 90% | – | – | – | 720k |
| | rules | 89% | 85% | – | – | – | 912k |

Told which session, the agent matches the injected folded view (98% / 95%)
and loads exactly one session every time. Left to choose, it loads the wrong
session about a third of the time it loads one at all, and often does not
load one, so recall collapses to 33 to 86%. The proxy choosing by BM25 and
injecting (`auto`) is better than the agent choosing but 8 to 10 points
below being told.

## Selection

Hit = the ranker's top session is the one the resume prompt was written
from. The planted repositories hold three sessions each generated from
overlapping outlines, so they are harder to tell apart than real sessions.

| ranker | planted dev (36 prompts) | planted test (72 prompts) | real history (80 prompts, 10 projects, 2–15 candidates) |
|---|---|---|---|
| recency | 33% | 33% | 15% |
| bm25 over the outline | 69% | **90%** | **86%** |
| bm25 over the folded view | 69% | 74% | – |
| e5 embeddings | 44% | 49% | – |
| jev | 67% | 58% | 78% |
| vote | 69% | 88% | 88% |

On real history, 9 of bm25's 11 misses rank the right session second, so
showing the top two covers about 97%.

## Other checks

- The handoff block is injected once and the prefix cache holds across the
  fresh session's requests: 0 of 319 dev sessions changed block size, 89%
  cache hit on follow-ups.
- Opening latency added by the handoff, median: cold 26 s, folded+recall
  29 s, full 38 s.
- The folded view of three real (non-generated) sessions of 28 to 59 turns
  renders to 27 to 73k tokens uncapped, 25 to 36k capped.

## Excluded runs

Four fresh sessions produced no recall answers and were excluded rather than
scored zero: two where the API's safety filter withheld the reply
(`s16.bug.cold+hint`, `s32.continue.cold`) and two where Claude Code refused
to trust the workspace (`s34.continue.cold+hint`,
`s34.continue.brief-opus+recall+`).

## Decision

Ship the manual route: `eunoe continue` hands the user a line naming the
session, the agent loads it with `eunoe load` and reads it whole. Neither the
agent choosing on its own nor the proxy choosing and injecting ships, because
a wrong session is worse than none and the selection error on real history
is one in seven. The injection headers were not kept in the proxy.
