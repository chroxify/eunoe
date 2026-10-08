# Real-session suite: rolling+both vs native (tag real-rb)

27 points (19 real, 8 synthetic), 318 vetted questions, answering model claude-sonnet-5-5, judges claude-opus-5-5 + claude-sonnet-5-5. Score = mean judge grade / 2.

| arm | recall | real only | tool_evidence | mid_history | instruction | decision | continuation | recent | 0-3 turns ago | 4-10 turns ago | 11-25 turns ago | 26+ turns ago | vs native (Δ, 95% CI, points better / worse) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| native+guide | **89%** | 92% | 89% | 89% | 97% | 79% | 86% | 88% | 86% | 89% | 88% | 93% | +28.8 [+20.9, +36.9] · 26 / 0 |
| native | **60%** | 60% | 37% | 70% | 94% | 55% | 76% | 33% | 54% | 69% | 61% | 56% | – |
| rolling+both | **89%** | 90% | 76% | 98% | 98% | 91% | 87% | 94% | 90% | 94% | 85% | 89% | +29.3 [+21.3, +37.0] · 23 / 4 |
