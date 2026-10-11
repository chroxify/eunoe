# eunoe

A local proxy between Claude Code and the Anthropic API that keeps long sessions sharp: finished turns fold to the user's message, the output lines that mattered and the reply; old detail comes back through keyword recall when a message is about it; nothing is ever lost because the whole session is rendered to searchable markdown. `README.md` is the product description and the place every user-facing claim lives.

## Layout

```
src/cli/          The `eunoe` / `ee` command
  commands/         one file per command, registered in index.ts
  terminal/         output, prompts, help and argument parsing; nothing eunoe-specific
  sessions/         finding, ranking and browsing earlier sessions
  proxy/            installing, probing and reporting on the running proxy
  replay/           replaying a session history through the proxy offline
  logo/             the terminal logo
src/proxy/        The HTTP proxy: request handling, compaction, token estimates, per-thread state, request log
src/context/      Pure message transforms over API bodies
  content.ts        the shared primitives: blocks, text, clipping, hashing
  prompts.ts        the notices and instructions the proxy writes into a request
  fold/             turns, evidence, strategies and the folded view
  recall/           keyword search over dropped output and the Jev reranker
src/transcript/   Reading Claude Code session files and rendering them to markdown or XML
src/config/       ~/.eunoe/config.json: defaults, validation, per-session overrides
test/             bun test, one file per area, fixtures.ts builds message histories
bench/            The benchmark: arms, suites, component evals and the published results (bench/README.md)
scripts/          Repo tooling (the conventions linter)
```

Every directory keeps its module-level values in `constants.ts` and its exported types in `types.ts`.

## Commands

| Command | Description |
|---|---|
| `bun run test` | The test suite |
| `bun check-types` | TypeScript over `src`, `test` and `bench` |
| `bun lint` | Biome (format, lint, the Grit plugin) and the conventions linter |
| `bun format:fix` | Biome auto-fix |
| `bunx knip` | Dead exports, files and dependencies; expected to be silent |
| `bun src/cli/main.ts <command>` | Run the CLI from source |

Husky runs lint-staged Biome and the conventions check on commit, a conventional-commit check on the message, and `check-types` plus the tests on push. CI (`.github/workflows/ci.yml`) runs the same.

## Conventions

- **No comments.** Names and structure carry the meaning; this file and `README.md` carry the reasons. `bun lint:conventions` fails on any comment.
- **Verbs.** Functions never start with `get`, `fetch`, `load`, `set`, `delete` or `destroy`. Use `read*` for files and state, `find*`, `list*`, `resolve*`, `create*`, `update*`, `save*`, `remove*`, `apply*`, `record*`.
- **Constants.** A module-level `UPPER_CASE` value lives in the directory's `constants.ts`, never beside the code that uses it. Prompt text (`SESSIONS_SECTION`, `CLEARED_OUTPUT`) counts.
- **Types.** Exported interfaces and type aliases live in the directory's `types.ts`. A type used by one file stays unexported in that file.
- **One of each.** Before writing a helper, look for the one that exists: `textOf`, `blocks`, `clip`, `truncate`, `shortHash` in `context/content.ts`; `parseJsonl` in `transcript/parse.ts`; `wrap`, `rows`, `table`, `fail` in `cli/terminal/ui.ts`; `interact` in `cli/terminal/prompt.ts` for every full-screen prompt.
- **Deterministic output.** Anything the proxy sends must be a pure function of the history plus saved thread state, so the prompt cache holds. Nothing time-based goes into a request.
- **The `eval` block in config is the benchmark's surface.** `EvalConfig` and every branch on `config.eval` (the `tail`, `guide` and `trim` strategies, `forceCut`, `rolling`, `trustHeaders`) exist so `bench/constants.ts` can express each arm as a `config.json`. They are not dead code; check `bench/` before removing one.
- **Tests.** Every behaviour change ships with a test in `test/`, built from `test/fixtures.ts`. Tests may use `any`; source never does outside the API payload types in `context/types.ts`.
- **Pinned exact versions** for every dev dependency added.

## Git

Agents never commit or push; the user reviews and commits. A commit message is one conventional-commit subject line (`fix(proxy): …`) and nothing else: no body, no trailers, no attribution.
