# Recall retrieval

Planted tool-output facts: 470; present in some chunk: 470 (100%). Hit = the value is inside the injected <recalled-context> for the fact's own question. Sessions: 37.

## Hit rate by fact type (planted)

| variant | tool_value | error | prose_value | superseded | all | median rank of first hit chunk | injected chars (median) | stale-only |
|---|---|---|---|---|---|---|---|---|
| v1 | 66% | 56% | 62% | 64% | 63% | 1 | 1102 | 4 |
| default | 93% | 93% | 87% | 88% | 91% | 2 | 3982 | 4 |
| no-narrative | 94% | 93% | 89% | 88% | 92% | 1 | 4196 | 4 |
| no-salient | 92% | 93% | 84% | 86% | 89% | 2 | 3811 | 4 |
| top4 | 85% | 73% | 81% | 78% | 81% | 2 | 1535 | 5 |
| top12 | 93% | 93% | 87% | 88% | 91% | 2 | 3982 | 4 |
| win6 | 93% | 93% | 87% | 88% | 91% | 2 | 3982 | 4 |
| win8 | 95% | 92% | 90% | 88% | 92% | 2 | 4638 | 4 |
| win6+top12 | 93% | 93% | 87% | 88% | 91% | 2 | 3982 | 4 |
| win6+top6 | 88% | 79% | 85% | 82% | 85% | 2 | 2121 | 4 |
| win4+top12 | 93% | 90% | 83% | 85% | 89% | 2 | 3284 | 5 |

## Hit rate by distance from the cut (planted)

| variant | 1–3 | 4–10 | 11–30 | 31–60 | 61+ |
|---|---|---|---|---|---|
| v1 | 67% | 62% | 63% | 58% | 67% |
| default | 94% | 90% | 91% | 96% | 83% |
| no-narrative | 95% | 91% | 91% | 96% | 86% |
| no-salient | 93% | 87% | 88% | 96% | 83% |
| top4 | 86% | 81% | 81% | 78% | 76% |
| top12 | 94% | 90% | 91% | 96% | 83% |
| win6 | 94% | 90% | 91% | 96% | 83% |
| win8 | 94% | 94% | 91% | 93% | 88% |
| win6+top12 | 94% | 90% | 91% | 96% | 83% |
| win6+top6 | 91% | 83% | 84% | 86% | 78% |
| win4+top12 | 93% | 88% | 85% | 96% | 83% |

## Real sessions (LLM-written questions)

Questions: 270; an answer token appears in some chunk (output or agent text): 267. Hit = any answer token inside the injected context.

| variant | tool_evidence | recent | mid_history | decision | instruction | all |
|---|---|---|---|---|---|---|
| v1 | 69% | 66% | 89% | 70% | 72% | 73% |
| default | 86% | 89% | 100% | 89% | 92% | 91% |
| no-narrative | 89% | 87% | 94% | 89% | 83% | 88% |
| no-salient | 84% | 89% | 100% | 89% | 92% | 90% |
| top4 | 79% | 74% | 98% | 89% | 89% | 85% |
| top12 | 86% | 89% | 100% | 89% | 92% | 91% |
| win6 | 86% | 89% | 100% | 89% | 92% | 91% |
| win8 | 88% | 87% | 100% | 89% | 92% | 91% |
| win6+top12 | 86% | 89% | 100% | 89% | 92% | 91% |
| win6+top6 | 85% | 79% | 100% | 89% | 91% | 88% |
| win4+top12 | 88% | 91% | 100% | 85% | 94% | 92% |
