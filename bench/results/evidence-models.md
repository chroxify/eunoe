# Evidence: model line pickers vs patterns (dev split)

Evaluated on the turns that hold a planted value (180 plants) and the source turns of real tool-output questions (110 questions), 321 distinct turns. Hit = the value survives in the turn's <tool-evidence>. Model pickers see each eligible command's output numbered by line (first and last 200 lines when longer) and return line numbers; "notes" writes free text instead. ∪ = model picks plus the pattern scorer's top 4 per command.

## Coverage

| arm | planted tool_value | error | prose_value | superseded (current) | superseded (stale) | all | real tool_evidence | real recent | real all |
| jev-latest picks | 74% | 63% | 89% | 67% | 67% | 73% | 92% | 82% | 87% |
| patterns ∪ jev-latest picks | 90% | 96% | 94% | 83% | 83% | 90% | 93% | 86% | 90% |
| jev-preview picks | 74% | 63% | 83% | 67% | 67% | 72% | 92% | 76% | 85% |
| patterns ∪ jev-preview picks | 90% | 96% | 92% | 83% | 83% | 89% | 93% | 84% | 89% |
|---|---|---|---|---|---|---|---|---|---|
| patterns | 97% | 100% | 94% | 100% | 92% | 97% | 87% | 72% | 80% |
| haiku picks | 85% | 88% | 89% | 79% | 83% | 85% | 77% | 90% | 83% |
| patterns ∪ haiku picks | 93% | 100% | 92% | 92% | 96% | 94% | 90% | 92% | 91% |
| haiku notes | 88% | 88% | 94% | 92% | 92% | 90% | 80% | 86% | 83% |
| ollama:qwen2.5:3b picks | 14% | 17% | 19% | 25% | 17% | 17% | 8% | 22% | 15% |
| patterns ∪ ollama:qwen2.5:3b picks | 71% | 92% | 61% | 79% | 75% | 73% | 65% | 70% | 67% |
| ollama:llama3.2:3b picks | 25% | 8% | 17% | 8% | 8% | 17% | 43% | 50% | 46% |
| patterns ∪ ollama:llama3.2:3b picks | 76% | 92% | 58% | 71% | 75% | 74% | 78% | 80% | 79% |

## Cost

| arm | chars per folded turn (mean / p95) | model calls | input tokens | ms per turn (median / p95) |
| jev-latest picks | 1776 / 5517 | 2434 | 4993675 | 265 / 390 |
| patterns ∪ jev-latest picks | 2321 / 6945 | 2434 | 4993675 | 265 / 390 |
| jev-preview picks | 1773 / 5586 | 2434 | 4993675 | 267 / 396 |
| patterns ∪ jev-preview picks | 2322 / 6905 | 2434 | 4993675 | 267 / 396 |
|---|---|---|---|---|
| patterns | 1732 / 4124 | – | – | – |
| haiku picks | 1431 / 4129 | 0 | 0 | – |
| patterns ∪ haiku picks | 1988 / 4979 | 0 | 0 | – |
| haiku notes | 737 / 1440 | 0 | 0 | – |
| ollama:qwen2.5:3b picks | 311 / 1403 | 321 | 735364 | 2175 / 22167 |
| patterns ∪ ollama:qwen2.5:3b picks | 1375 / 3401 | 321 | 735364 | 2175 / 22167 |
| ollama:llama3.2:3b picks | 648 / 1970 | 321 | 675924 | 1597 / 24855 |
| patterns ∪ ollama:llama3.2:3b picks | 1538 / 3555 | 321 | 675924 | 1597 / 24855 |
