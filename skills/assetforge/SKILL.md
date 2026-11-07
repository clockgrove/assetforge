---
name: assetforge
description: Use when you need to generate candidate game assets within a cost cap and stage them, with QA and provenance, for a human to pick.
---

# Assetforge

Assetforge generates game assets through generation models and stages the ones that pass QA, with provenance, for a human to review.

Run it as `npx @clockgrove/assetforge@<version> <command>`, or as `assetforge` (`pnpm exec assetforge`) when the game pins it as a dev dependency.

## Contract

- Always pass `--json`. Stdout is exactly one JSON document with `ok`, `exitCode`, `command` and, on refusal, `error: { code, message }`.
- Logs go to stderr. It never prompts.

## Commands

- `stage --spec <spec.json> --bible <bible.json> --profile <profile.json> [--candidates 4] [--cap 5] [--routes <routes.json>] [--runs .assetforge/runs] [--provider-script <module.js>] [--dry-run] [--json]`
  Generates candidates within the USD cost cap and stages only those passing QA, with reasons and provenance, in a run directory. `--dry-run` reports the planned calls and cost forecast and spends nothing (needs no key).
- `pick --run <dir> --candidate <id> --target <dir> [--json]`
  Writes the chosen candidate and manifest into the target with review pending.
- `import --sheet <sheet.png> --profile <profile.json> --asset <id> --tool <name> [--bible <bible.json>] [--hints idle,walk-right] [--grid <columns>] [--components] [--no-propose] [--cap 5] [--provider-script <module.js>] [--json]`
  Slices a contact sheet into frames and has a vision model propose animation families in `<import>/grouping.json` with status `proposed` (`--no-propose` calls no model).
- `generate-sheet --spec <spec.json> --bible <bible.json> --profile <profile.json> [--cap 5] [--provider-script <module.js>] [--dry-run] [--json]`
  Has the model draw a whole cycle as one sheet within the cap, then imports it.
- `write-families --import <dir> --target <dir> [--grouping <file>] [--json]`
  Writes the strips of a grouping a human set to `confirmed` into the target with review pending.
- `--help`, `--version`; `<command> --help` for one command's options. With `--json`, help is a JSON document whose `usage` field holds the text.

## Exit codes

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| 0    | Success                                                                  |
| 1    | Unexpected internal error                                                |
| 2    | Invalid input                                                            |
| 3    | Cap refused (also a dry-run forecast over the cap)                       |
| 4    | Provider error (missing `AI_GATEWAY_API_KEY`, or every candidate failed) |
| 5    | QA found nothing                                                         |
| 6    | The target's validator rejected what was written                         |

## Environment and network

- Reads `AI_GATEWAY_API_KEY` (Vercel AI Gateway key), from the environment only. Not needed for `--dry-run` or `--provider-script`.
- Reaches only `ai-gateway.vercel.sh` (HTTPS), and only for `stage`, `generate-sheet` and `import` (without `--no-propose`), never with `--dry-run` or `--provider-script`. `pick` and `write-families` run the target profile's own validator command locally. A sandbox can allow just that host.

## The rule (PRD section 5.7)

**Agents may stage candidates, generate and import sheets (and dry-run first to check cost). Agents never run `pick`, never confirm a grouping or run `write-families`, and never approve. A human picks, and Assetforge never marks anything approved.** Report the staged run or import directory and the candidate IDs to the human instead.

## Suggested flow

1. `stage --dry-run --json` to check the plan and cost forecast.
2. `stage --json` to generate and stage candidates.
3. Hand the run directory and candidate IDs to the human.
