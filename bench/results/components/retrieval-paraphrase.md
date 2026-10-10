# Recall retrieval on paraphrased questions (dev)

2026-10-09. The same 423 dev questions (156 planted, 267 real), each rewritten
by Opus the way a person asks from vague memory, with a hard rule to use none
of the content words of the original question or of the log line that answers
it (159 still shared one term after three attempts). This is the "weird login
issue we fixed earlier" case: the meaning is there, the words are not.

| arm | planted | real | ms/query |
|---|---|---|---|
| bm25 (candidates for the shipped stack) | 0% | 42% | 7 |
| bm25, 1 matched term | 0% | 46% | 7 |
| hybrid bm25 + e5-small (local index) | 1% | 65% | 16 |
| cross-encoders over bm25 (minilm / bge / mxbai) | 0% | 45–48% | 311–1416 |
| Haiku query rewrite → bm25 | 25% | 64% | 797 |
| Jev rerank over bm25 (shipped) | 0% | 49% | 272 |
| Jev rerank over hybrid bge-small | 8% | 67% | 282 |
| Jev rerank over hybrid e5-small | 7% | 68% | 287 |

Candidate coverage (answer inside the top 30): bm25 0% / 47%, hybrid e5 8% / 76%,
Haiku rewrite 36% / 80%.

## Reading

- The shipped stack's weakness is candidate generation, not ranking. When the
  words differ, bm25 never surfaces the chunk and Jev has nothing to reorder:
  49% on real questions, 0% on planted.
- Semantic candidates fix a large part of it: hybrid bm25 + e5-small lifts
  real questions from 42% to 65% at 16 ms with no model call, and Jev on top
  reaches 68%.
- Query rewriting (Haiku writes the words a log line would contain) is the
  only arm that recovers planted values (25%), because planted questions name
  a command's output and the rewrite guesses the command. It costs a hosted
  call and ~800 ms.
- Planted at 0–8% is partly an artefact: the paraphrase rule also stripped
  the command's own name, which a person would usually keep ("the deploy").
  The real-question column is the fairer read.
- Not yet run: rewrite → hybrid → Jev (all three together). Queued.

## Decision (amendment to bench/SPEC.md §D, 2026-10-09)

Hybrid candidates beat bm25 by far more than the pre-registered 2 points on
paraphrased questions (+23 real) while costing nothing on the original
questions (92/93 vs 88/91, from the round-2 matrix). A local e5-small index
over dropped output is adopted as the candidate generator **when the embedder
is available**, with bm25 alone as the fallback; Jev reranks either. The
handoff suite's recall arms inherit this once wired.
