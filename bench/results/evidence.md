# Evidence coverage

Planted facts placed in tool output: 542; found in that turn's output: 542 (100%). Sessions: 37.

## Coverage by fact type (planted)

| variant | tool_value | error | prose_value | superseded (current) | superseded (stale) | all |
|---|---|---|---|---|---|---|
| v1 | 62% | 78% | 66% | 61% | 51% | 63% |
| default | 96% | 99% | 98% | 97% | 97% | 97% |
| wide | 92% | 97% | 95% | 94% | 93% | 94% |
| deep | 96% | 99% | 98% | 97% | 97% | 97% |
| loose | 96% | 99% | 98% | 97% | 97% | 97% |
| alltools | 96% | 97% | 98% | 97% | 97% | 97% |
| wide+deep | 92% | 97% | 95% | 94% | 93% | 94% |
| wide+deep+loose | 92% | 97% | 95% | 94% | 93% | 94% |
| wide+deep+alltools | 92% | 96% | 95% | 94% | 93% | 94% |
| xwide+deep | 96% | 99% | 98% | 97% | 97% | 97% |
| ranked | 92% | 97% | 95% | 94% | 93% | 94% |
| ranked+labels | 92% | 97% | 95% | 94% | 93% | 94% |
| ranked+labels+loose | 92% | 97% | 95% | 94% | 93% | 94% |
| ranked+labels+loose 2k | 92% | 97% | 94% | 94% | 92% | 93% |
| ranked+labels+loose 12/4k | 96% | 99% | 98% | 97% | 97% | 97% |
| floor0 | 96% | 99% | 98% | 97% | 97% | 97% |
| floor4 | 96% | 99% | 98% | 97% | 97% | 97% |
| default 3k | 96% | 99% | 98% | 97% | 97% | 97% |
| default 6k | 96% | 99% | 98% | 97% | 97% | 97% |

## Coverage by distance from the cut (planted)

| variant | 1–3 | 4–10 | 11–30 | 31–60 | 61+ |
|---|---|---|---|---|---|
| v1 | 64% | 67% | 61% | 62% | 61% |
| default | 96% | 97% | 98% | 97% | 99% |
| wide | 93% | 94% | 95% | 91% | 96% |
| deep | 96% | 97% | 98% | 97% | 99% |
| loose | 96% | 97% | 98% | 97% | 99% |
| alltools | 96% | 96% | 98% | 97% | 99% |
| wide+deep | 93% | 94% | 95% | 91% | 96% |
| wide+deep+loose | 93% | 94% | 95% | 91% | 96% |
| wide+deep+alltools | 93% | 93% | 95% | 91% | 96% |
| xwide+deep | 96% | 97% | 98% | 97% | 99% |
| ranked | 93% | 94% | 95% | 91% | 96% |
| ranked+labels | 93% | 94% | 95% | 91% | 96% |
| ranked+labels+loose | 93% | 94% | 95% | 91% | 96% |
| ranked+labels+loose 2k | 92% | 93% | 94% | 91% | 96% |
| ranked+labels+loose 12/4k | 96% | 97% | 98% | 97% | 99% |
| floor0 | 96% | 97% | 98% | 97% | 99% |
| floor4 | 96% | 97% | 98% | 97% | 99% |
| default 3k | 96% | 97% | 98% | 97% | 99% |
| default 6k | 96% | 97% | 98% | 97% | 99% |

## Cost (every turn of every session)

| variant | evidence chars / turn (mean) | p95 | share of eligible output kept |
|---|---|---|---|
| v1 | 448 | 1045 | 39.9% |
| default | 731 | 1833 | 65.0% |
| wide | 628 | 1540 | 55.9% |
| deep | 731 | 1833 | 65.0% |
| loose | 731 | 1833 | 65.0% |
| alltools | 1323 | 2576 | 25.4% |
| wide+deep | 628 | 1540 | 55.9% |
| wide+deep+loose | 628 | 1540 | 55.9% |
| wide+deep+alltools | 1147 | 2142 | 22.1% |
| xwide+deep | 731 | 1833 | 65.0% |
| ranked | 628 | 1540 | 55.9% |
| ranked+labels | 628 | 1540 | 55.9% |
| ranked+labels+loose | 628 | 1540 | 55.9% |
| ranked+labels+loose 2k | 626 | 1540 | 55.7% |
| ranked+labels+loose 12/4k | 731 | 1833 | 65.0% |
| floor0 | 731 | 1833 | 65.0% |
| floor4 | 731 | 1833 | 65.0% |
| default 3k | 730 | 1833 | 65.0% |
| default 6k | 731 | 1833 | 65.0% |

## Real sessions (tool_evidence + recent questions)

Questions: 135; answer tokens found in the source turn's output (±1 turn): 114. Hit = any answer token survives in evidence.

| variant | tool_evidence | recent | all |
|---|---|---|---|
| v1 | 69% | 62% | 66% |
| default | 85% | 69% | 78% |
| wide | 87% | 67% | 78% |
| deep | 85% | 69% | 78% |
| loose | 85% | 69% | 78% |
| alltools | 85% | 71% | 79% |
| wide+deep | 87% | 67% | 78% |
| wide+deep+loose | 87% | 67% | 78% |
| wide+deep+alltools | 87% | 69% | 79% |
| xwide+deep | 90% | 71% | 82% |
| ranked | 87% | 67% | 78% |
| ranked+labels | 87% | 67% | 78% |
| ranked+labels+loose | 87% | 67% | 78% |
| ranked+labels+loose 2k | 76% | 67% | 72% |
| ranked+labels+loose 12/4k | 85% | 69% | 78% |
| floor0 | 82% | 67% | 75% |
| floor4 | 90% | 69% | 81% |
| default 3k | 84% | 69% | 77% |
| default 6k | 90% | 71% | 82% |
