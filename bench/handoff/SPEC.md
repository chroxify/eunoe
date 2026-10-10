# Handoff suite: the cold start

Pre-registered 2026-10-09, before any arm ran. Sections 1–7 are frozen once
the first dev run starts; later changes go in dated amendments in §8.

## 1. The question

When a developer opens a **fresh** Claude Code session to continue work that
an earlier session did, how much of that earlier session's knowledge does the
new agent have, and how cheaply? Two shapes of the problem:

- **The bug from last week.** A feature was built in a long session. Days
  later a specific bug in it needs fixing. The new agent knows nothing: not
  the values the deploy printed, not the error that was chased, not the
  decision that ruled out the obvious fix.
- **Taste and rules.** Over a session the developer gave feedback and rules
  (branch prefixes, who reviews, what never to touch, how replies should
  read). The next session starts from zero and has to be taught again.

The in-session suite showed eunoe keeps 99% of planted facts through a fold.
This suite asks whether the same ingredients (folded turns, evidence lines,
recall) can carry that knowledge **across** sessions, and which way of
carrying it is best.

## 2. Material

The 36 planted sessions (`bench/out/planted/sessions`), unchanged. Each has 25
planted facts with a question each and a task for every instruction-type
fact, scored by exact match. Twelve repositories hold three sessions each
(one holds one), so every source session has two same-repository distractors.

Split: the same dev/test split as the planted suite (index % 3 == 0 is dev:
12 sessions; the other 24 are test). Methods are chosen on dev and frozen
before test runs.

## 3. Protocol

For each source session S in repository R:

1. A **fresh** Claude Code session starts in R's working directory with the
   same pinned system prompt the other suites use, no history, MCP off, the
   repository's own CLAUDE.md as it is.
2. Its first prompt is a **resume prompt** written by Opus from S's title and
   outline in the developer's own style: one or two sentences saying what
   they want to get back to, naming the feature or bug in everyday words and
   **never quoting a planted value**. Three resume prompts per session, one
   per scenario:
   - `bug`: come back to fix a specific problem in what S built
   - `continue`: pick the work up where S left it
   - `rules`: start something new in the same area (tests the rules carry)
3. The arm's handoff mechanism acts on that first prompt (what gets injected,
   what the agent is told).
4. The agent is then asked S's tasks (instruction application, unprompted)
   and S's recall questions, exactly as the planted suite does, by the same
   runner and scorer. Transcript lookups and tokens are counted.

Handoff happens **once**, at the first prompt; nothing else about the fresh
session is managed, so the measurement is the handoff alone.

## 4. Arms

Baselines:

| arm | first prompt sees |
|---|---|
| `cold` | nothing. What Claude Code gives you today. |
| `cold+hint` | one line: S's transcript folder exists at this path, search it. The agent-driven ceiling. |
| `full` | S's whole history prepended verbatim (where it fits). The ceiling for injected context. |

Handoff mechanisms, each injected into the first prompt as a
`<handoff from="…">` block, computed once and pinned so caching holds:

| arm | content |
|---|---|
| `folded` | S as eunoe's folded view: every user message, evidence lines, every final reply. The in-session representation, reused. ~Tens of k tokens. |
| `folded-capped` | `folded` trimmed to 20k tokens, newest turns first, user messages always kept. |
| `rules` | S's standing instructions, extracted verbatim by Opus (user text only, with revisions resolved to the current rule), plus S's last three final replies. ~2k. |
| `brief` | A model-written brief from the folded view: what was built, where things live, rules in force, decisions and rejected options, open items, exact values worth keeping. Three sizes (Haiku, Sonnet, Opus writer). ~3k. |
| `recall` | Nothing up front. Cross-session recall: on **every** prompt of the fresh session, search S's dropped output and narrative with the prompt, bm25 → Jev, and append matches. The in-session recall, pointed at a past session. |
| `rules+recall` | the two combined |
| `brief+recall` | the two combined |
| `folded-capped+recall` | the two combined |

Selection (which past session to hand off from) is a separate tier, §5, so
the arms above are given S. A final `auto` arm runs the selection tier's
winner end to end with the best mechanism, against all three of R's sessions
as candidates.

Retrieval stack: whatever the paraphrase eval (dated amendment below) settles
for in-session recall is used here unchanged. If a hybrid bm25 + local
embedding candidate set wins there, cross-session recall uses it too.

## 5. Selection tier

Given a resume prompt and the three sessions of R, pick the source. Ground
truth is the session the prompt was written from. Candidates are scored by:

| ranker | over |
|---|---|
| `bm25` | each session's `index.md` (one line per turn) |
| `bm25-full` | each session's folded view |
| `e5` | embeddings of `index.md` |
| `jev` | a Jev `choice` over the three `index.md`s |
| `recency` | the most recent session, always (the naive default) |

Reported as accuracy over 36 × 3 prompts. Multi-source is out of scope: the
best single session is handed off. (Amendment candidate: merge top two.)

## 6. Measures and hypotheses

Per arm, dev and test separately: facts remembered (exact match), rules
applied unprompted in tasks, unknown and wrong rates, prompt size at the
first response, total tokens to answer, transcript lookups, and the latency
the handoff added before the first response.

- **C1** Every handoff arm remembers more than `cold` (95% bootstrap CI over
  sessions excludes zero).
- **C2** The best mechanism remembers ≥ 90% of S's facts from a fresh
  session.
- **C3** It applies S's rules unprompted at least as well as the in-session
  `default` arm did (lower bound > −5 points).
- **C4** It does so at ≤ 25% of `full`'s prompt size.
- **C5** `recall`-bearing arms need fewer transcript lookups than
  `cold+hint` (the agent should not have to go and dig).
- **C6** Selection: the best ranker picks the right session ≥ 90% of the
  time; `recency` is reported as the bar it must beat.

Winner rule, decided now: highest facts remembered on dev; ties broken by
rules applied, then smaller prompt. Frozen in `FROZEN.md` before the test
split runs.

## 7. What this does not test

One developer's repositories; generated sessions; one answering model
(Sonnet); the fresh session is one prompt plus questions, not a day of work.
A week's drift in the repository (commits by others) is not simulated: the
working tree is the same one S saw.

## 8. Amendments

**2026-10-09, before the test split.** Added during dev iteration, all run on
dev before any freeze: `folded+recall`; a `recall+` family whose cross-session
recall also indexes the developer's own messages from the source session and
has a wider per-prompt budget (30k / 90k chars, 6 per query), alone and with
`rules`, `brief-opus`, and folded views capped at 40k, 60k and 80k chars;
`recall-all+` (recall over every session of the repository, no selection);
`auto` (bm25 picks the source among the repository's sessions, its 60k folded
view is injected, recall runs over all of them) and `auto-full` (same with the
uncapped folded view). Selection tier gained `jev-folded` and `vote`. The
three sessions per repository were generated from overlapping outlines (every
feedbase session has webhook retries and pagination), so selection is harder
here than between real sessions; reported as is.

**2026-10-09, before the test split.** Dev complete (26 arms). Winner by §6:
`folded+recall` (100 / 95 / 126k); runner-up `folded`. `brief-opus+recall+`
(97 / 93 / 63k) is also run on test as the arm within C4's prompt bound; it is
reported, not pre-registered as the winner. `index: hybrid` reverted to opt-in
(see bench/SPEC.md §D, same date); no hybrid arm runs on test. Selection on
test: recency, bm25, jev, vote.

**2026-10-09 14:40, before the test split finished.** Added, all reported but
none pre-registered as winner: (a) selection on real history
(`select-real.ts`, 40 sessions / 10 projects / 80 prompts) as the number that
decides whether auto-pick ships; (b) multi-source injection arms
`multi2+recall+` and `multi-all+recall+` (top-k sessions by bm25, folded views
under one 120k budget, recall over all siblings), the amendment candidate
named in §5; (c) the composed recall stack end to end: a proxy-side query
rewrite (`rewrite` setting, Haiku through the user's own auth headers) and the
hybrid index with the embedder moved to a worker thread, as arms
`folded+recall-rw`, `folded+recall-rwh`, `brief-opus+recall-rwh+`,
`recall-rwh+` on dev. (d) The harness pins one cswap account per run; a
per-call rotation introduced the same morning poisoned 43 runs with
"No conversation found", all purged and rerun before any table was read.
