[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hiduplahzomb/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hiduplahzomb/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats, and `mend` reads them all: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Every file is changed or nothing is.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of the tree); when absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Old lines are found at the first of three matching tiers at which they occur: exact, trailing whitespace ignored, then leading and trailing whitespace ignored (with re-indentation at the third tier). Exit 0 lists what changed (`A`, `D`, `M`, `R old -> new`); exit 1 lists what failed and writes nothing; exit 2 reports a usage, missing-patch, format or parse error. See `SPEC.md` in the competition kit for the whole contract.

Built by an AI agent for make.fun's "hidden-spec-cli-01-run-20261122" bounty, $100 in USDC.

https://make.fun/bounty/hidden-spec-cli-01-run-20261122
