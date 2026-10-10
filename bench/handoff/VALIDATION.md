# Validation checklist: cold start and semantic recall

Written 2026-10-09 14:45 CEST. Every item is a thing that has to be true
before either feature ships. Status is filled in as results land; nothing is
marked done from memory. Final verdicts go to `RESULTS.md`.

## A. Cold start (handoff)

| # | detail | how it is checked | status |
|---|---|---|---|
| A1 | a fresh session with the folded view remembers S's facts | planted handoff suite, test split, `folded+recall` vs `cold` (C1, C2) | running (test2) |
| A2 | it applies S's rules unprompted | same, rules column (C3) | running |
| A3 | prompt cost stays bounded | prompt at tasks vs `full` (C4) | running |
| A4 | the agent does not have to dig | lookups vs `cold+hint` (C5) | running |
| A5 | all three scenarios (bug / continue / rules) hold | per-scenario table | running |
| A6 | the right source session is picked | selection tier on test (C6) | chained |
| A7 | selection on real history, distinct titles | `select-real.ts`: 40 real sessions, 10 projects, 80 prompts | done: vote 88%, bm25 86%, Jev 78%, recency 15%; in 9 of bm25's 11 misses the right session is ranked #2, so top-2 covers ~97% |
| A8 | more than one source helps when selection is unsure | `multi2+recall+`, `multi-all+recall+` on dev | chained |
| A9 | the handoff block is injected once and the cache holds across requests | unit test + proxy logs of 319 dev sessions | done: 0 sessions changed block size; 89% cache hit on follow-ups |
| A10 | cross-session recall works with several sources and labels them | `embed.test.ts` multi-source test | done |
| A11 | the folded view of a real (non-generated) session renders sanely | `tools/fold-real.ts` on 3 real sessions | done: 28–59 turns → 27–73k tokens uncapped, 25–36k capped |
| A12 | opening latency added by the handoff | `openingMs` per arm, dev | done: cold 26 s, folded+recall 29 s, full 38 s (median) |
| A13 | no planted value leaks into a resume prompt | prepare.ts leak check | done at prepare |
| A14 | the untrusted (shipped) path: auto-select + inject + recall with no bench headers | `handoff` setting, `proxy/handoff-source.ts`, `autoHandoff` in rewrite; `test/auto-handoff.test.ts` (4 cases: match, pick by content, no match / other cwd / off, subagent guard) | done |
| A15 | Jev down → handoff still works on bm25 | rerank fallback test | done (rerank.test) |

## B. Semantic recall

| # | detail | how it is checked | status |
|---|---|---|---|
| B1 | lexical candidates fail on paraphrased questions | paraphrase eval, bm25 row | done: 0% / 42% |
| B2 | hybrid candidates recover part of it in isolation | paraphrase eval, hybrid row | done: 1% / 65% |
| B3 | rewrite → hybrid → Jev is the best vague-question stack | paraphrase eval, composed rows | done: 47% / 77% |
| B4 | Jev can do the rewrite without a generative model | `jev rewrite` arms on paraphrase | done, negative: Jev term selection → bm25 0% / 64%, → hybrid → Jev 10% / 72%, at ~2.5 s per query; Haiku rewrite → hybrid → Jev is 47% / 77% at 0.3 s. Jev can rank but cannot invent the missing words. |
| B5 | the composed stack does not regress on normal questions | retrieval eval, normal dev set | done: rewrite→hybrid→Jev 97/95, rewrite→bm25→Jev 95/95, bm25→Jev 95/94 |
| B6 | why hybrid regressed end to end | proxy logs: hybrid fired on 395/822 openings; openings 73 s vs 25 s | done: in-process embedder blocked the proxy; moved to a worker thread |
| B7 | hybrid index code is correct in isolation | `test/embed.test.ts` (fuse, round trip, dense order) + `test/embed-worker.test.ts` (real model in a worker, loop stays responsive) | done |
| B8 | hybrid never stalls a request | `embed.test.ts` slow-embedder test | done |
| B9 | the proxy reports which stack ran | `hybrid` / `reranked` / `rerankError` in request log | done |
| B10 | end-to-end with the composed stack | proxy-side `rewrite` setting + worker embedder; planted dev arms `default+rewrite`, `default+hybrid`, `default+rewrite+hybrid`; handoff dev arms `*-rw`, `*-rwh` | running |

## C. Ship decision inputs

- Default long-session recall stack (bm25 → Jev, bm25 fallback): keep, or add rewrite?
- Cold start: ship auto handoff? With which mechanism and which selector?
- Hybrid index: opt-in, default, or remove?
