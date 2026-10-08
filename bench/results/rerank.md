# Recall with a Haiku reranker (round 1) (claude-haiku-4-5-20251001, BM25 top-30 → model picks ≤4)

Planted (dev split): | tool_value 89% | error 79% | prose_value 100% | superseded 71% | all 87% |
Real: | tool_evidence 85% | recent 85% | mid_history 93% | decision 93% | instruction 92% | all 89% |
planted: answer within BM25 top-30: 98% (153/156)
planted: picked chunk holds answer: 96% (149/156)
real: answer within BM25 top-30: 98% (261/267)
Model calls: 423, input tokens: 2625980
