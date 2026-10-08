# Recall retrieval: rankers compared (dev split)

Same corpus (6-line windows + agent narrative), same rendering (top 12, salient excerpt, default budgets), same exact-match hit. Rerankers re-order the base ranker's top 30. 156 planted questions, 267 real.

## Hit rate inside the injected context

| arm | planted tool_value | error | prose_value | superseded | all | real tool_evidence | recent | mid_history | decision | instruction | all |
| jev-latest rerank | 97% | 92% | 94% | 92% | 95% | 91% | 92% | 100% | 100% | 92% | 94% |
| jev-latest rerank over hybrid:bge-small | 97% | 96% | 89% | 96% | 95% | 86% | 91% | 100% | 96% | 98% | 93% |
| jev-preview rerank | 97% | 92% | 94% | 92% | 95% | 91% | 92% | 100% | 100% | 94% | 95% |
| jev-preview rerank over hybrid:bge-small | 97% | 96% | 89% | 96% | 95% | 86% | 91% | 100% | 96% | 98% | 93% |
|---|---|---|---|---|---|---|---|---|---|---|---|
| bm25 | 90% | 83% | 86% | 88% | 88% | 86% | 89% | 100% | 89% | 92% | 91% |
| bm25 min1 | 90% | 83% | 86% | 83% | 87% | 86% | 89% | 100% | 100% | 92% | 92% |
| dense:minilm | 68% | 71% | 69% | 63% | 68% | 74% | 77% | 100% | 96% | 96% | 87% |
| dense:bge-small | 76% | 83% | 72% | 58% | 74% | 76% | 79% | 100% | 96% | 96% | 88% |
| dense:bge-base | 74% | 83% | 83% | 71% | 77% | 78% | 85% | 100% | 100% | 94% | 89% |
| dense:e5-small | 81% | 96% | 78% | 83% | 83% | 78% | 81% | 100% | 96% | 94% | 88% |
| dense:gte-small | 69% | 79% | 64% | 63% | 69% | 71% | 75% | 100% | 96% | 94% | 85% |
| dense:nomic | 72% | 88% | 78% | 75% | 76% | 73% | 83% | 100% | 96% | 92% | 87% |
| hybrid:minilm | 85% | 83% | 78% | 88% | 83% | 83% | 85% | 100% | 100% | 94% | 91% |
| hybrid:bge-small | 88% | 88% | 83% | 88% | 87% | 78% | 87% | 100% | 100% | 94% | 90% |
| hybrid:bge-base | 90% | 92% | 86% | 88% | 89% | 81% | 85% | 100% | 100% | 94% | 90% |
| hybrid:e5-small | 92% | 96% | 89% | 96% | 92% | 83% | 92% | 100% | 100% | 96% | 93% |
| hybrid:gte-small | 82% | 88% | 86% | 79% | 83% | 79% | 79% | 100% | 100% | 94% | 88% |
| hybrid:nomic | 89% | 96% | 83% | 92% | 89% | 78% | 89% | 100% | 96% | 94% | 90% |
| ce-minilm over bm25 | 81% | 88% | 78% | 88% | 82% | 88% | 91% | 100% | 100% | 92% | 93% |
| ce-bge over bm25 | 94% | 92% | 89% | 92% | 92% | 88% | 92% | 98% | 100% | 94% | 93% |
| ce-mxbai over bm25 | 63% | 58% | 61% | 54% | 60% | 83% | 89% | 98% | 96% | 94% | 91% |
| ce-minilm over hybrid:bge-small | 76% | 92% | 78% | 92% | 81% | 83% | 89% | 100% | 100% | 92% | 91% |
| haiku rerank | 96% | 92% | 94% | 92% | 94% | 91% | 91% | 100% | 100% | 91% | 94% |
| haiku rerank over hybrid:bge-small | 97% | 96% | 89% | 96% | 95% | 80% | 93% | 100% | 100% | 100% | 93% |
| sonnet rerank | 94% | 92% | 92% | 92% | 93% | 91% | 89% | 100% | 100% | 94% | 94% |
| haiku rewrite → bm25 | 93% | 83% | 92% | 83% | 90% | 85% | 91% | 100% | 96% | 91% | 91% |

## Ranking quality and cost

| arm | answer within top 12 (planted / real) | within top 30 (planted / real) | ms per query (median / p95) | injected chars (median) | index ms per 1k chunks | model calls | input tokens |
| jev-latest rerank | 96% / 96% | 96% / 97% | 286 / 524 | 4365 | – | 846 | 3908713 |
| jev-latest rerank over hybrid:bge-small | 96% / 94% | 96% / 95% | 312 / 539 | 4533 | – | 846 | 3908713 |
| jev-preview rerank | 96% / 96% | 96% / 97% | 292 / 520 | 4382 | – | 846 | 3908713 |
| jev-preview rerank over hybrid:bge-small | 96% / 94% | 96% / 95% | 319 / 487 | 4533 | – | 846 | 3908713 |
|---|---|---|---|---|---|---|---|
| bm25 | 88% / 92% | 95% / 96% | 6 / 11 | 4379 | – | – | – |
| bm25 min1 | 88% / 93% | 96% / 97% | 6 / 10 | 4378 | – | – | – |
| dense:minilm | 68% / 85% | 79% / 90% | 4 / 10 | 4008 | – | – | – |
| dense:bge-small | 74% / 87% | 83% / 90% | 9 / 39354 | 4218 | 32218 | – | – |
| dense:bge-base | 78% / 88% | 87% / 91% | 13 / 76918 | 4234 | 37202 | – | – |
| dense:e5-small | 83% / 87% | 88% / 91% | 5 / 31102 | 4402 | 15510 | – | – |
| dense:gte-small | 69% / 86% | 77% / 90% | 5 / 29773 | 4016 | 15644 | – | – |
| dense:nomic | 76% / 87% | 85% / 91% | 14 / 82270 | 4363 | 46570 | – | – |
| hybrid:minilm | 83% / 91% | 96% / 96% | 11 / 18 | 4347 | – | – | – |
| hybrid:bge-small | 87% / 90% | 96% / 95% | 13 / 19 | 4495 | 32218 | – | – |
| hybrid:bge-base | 90% / 90% | 96% / 95% | 19 / 28 | 4407 | 37202 | – | – |
| hybrid:e5-small | 93% / 93% | 97% / 96% | 12 / 18 | 4608 | 15510 | – | – |
| hybrid:gte-small | 84% / 89% | 94% / 94% | 12 / 18 | 4415 | 15644 | – | – |
| hybrid:nomic | 90% / 90% | 96% / 96% | 21 / 30 | 4565 | 46570 | – | – |
| ce-minilm over bm25 | 83% / 93% | 96% / 97% | 274 / 397 | 4601 | – | – | – |
| ce-bge over bm25 | 93% / 94% | 96% / 97% | 1098 / 1507 | 4420 | – | – | – |
| ce-mxbai over bm25 | 60% / 91% | 96% / 97% | 750 / 1164 | 4403 | – | – | – |
| ce-minilm over hybrid:bge-small | 82% / 91% | 96% / 95% | 249 / 403 | 4627 | – | – | – |
| haiku rerank | 95% / 94% | 96% / 97% | 883 / 1682 | 4372 | – | 726 | 3122608 |
| haiku rerank over hybrid:bge-small | 96% / 93% | 96% / 93% | 889 / 1739 | 4457 | – | 726 | 3122608 |
| sonnet rerank | 94% / 95% | 96% / 97% | 1595 / 2454 | 4378 | – | 423 | 2324258 |
| haiku rewrite → bm25 | 90% / 92% | 96% / 97% | 919 / 1534 | 4350 | – | 423 | 3122608 |
