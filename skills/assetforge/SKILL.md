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

## Generation plans

For repository-owned art direction, initialize the target's constitution with
`bible init --directory <target> --world <name> --preset <preset> --json`.
Load `bible describe --bible <BIBLE.md> --json` before writing a structured brief.
The presets are `cozy-storybook`, `flat-cartoon-kids` and `dark-gritty-isometric`.
Switch look and tone with `bible preset --bible <BIBLE.md> --preset <preset> --json`;
it retains the world palette, anchors and identity locks and invalidates earlier plans.

Use `plan --spec <spec.json> --bible <BIBLE.md> --profile <profile.json>
--brief <brief.json> --out <plan.json> --json` to compile a reviewable plan without
generating images. Show its prompts, clamps and cost forecast to the human.
`apply <plan.json> --json` requires the human to set the plan's `approved` field;
an unattended campaign uses `--auto-approve` to authorize generation spend.
This approval never approves an asset. Apply refuses stale bible, template,
identity and reference inputs. `mcp` exposes the same flow over stdio.

See [generation knobs](https://github.com/clockgrove/assetforge/blob/main/docs/generation-knobs.md) in the source repository
for the brief, run settings and versioned target template formats.

## Commands

- `stage --spec <spec.json> --bible <bible.json> --profile <profile.json> [--candidates 4] [--cap 5] [--routes <routes.json>] [--runs .assetforge/runs] [--provider-script <module.js>] [--dry-run] [--json]`
  Generates candidates within the USD cost cap and stages only those passing QA, with reasons and provenance, in a run directory. `--dry-run` reports the planned calls and cost forecast and spends nothing (needs no key).
- `pick --run <dir> --candidate <id> --target <dir> [--json]`
  Writes the chosen candidate and manifest into the target with review pending.
- `import --sheet <sheet.png> --profile <profile.json> --asset <id> --tool <name> [--bible <bible.json>] [--hints idle,walk-right] [--frames <count>] [--grid <columns>] [--components] [--no-propose] [--cap 5] [--provider-script <module.js>] [--json]`
  Slices a contact sheet into frames and has a vision model propose animation families in `<import>/grouping.json` with status `proposed` (`--no-propose` calls no model). With `--frames`, a sheet that does not slice into exactly that many figures is refused (exit 2), naming the cells behind it.
- `generate-sheet --spec <spec.json> --bible <bible.json> --profile <profile.json> [--brief <brief.json>] [--cap 5] [--provider-script <module.js>] [--dry-run] [--json]`
  Has the model draw a whole cycle as one sheet within the cap, then imports it. A sheet that does not slice into the spec's `frames.count` figures exits 5; the sheet and its record are kept in the import directory.
- `write-families --import <dir> --target <dir> [--grouping <file>] [--json]`
  Writes the strips of a grouping a human set to `confirmed` into the target with review pending.
- `op <operation> <input...> --out <path> [--params <json>] [--profile <profile.json>] [--json]`
  Runs one image operation (`assetforge ops` lists them with their parameter schemas) on any image and writes the output and a provenance record. Local, with no model call and no spend.
- `recipe <recipe.json> <input...> --out <path> [--profile <profile.json>] [--json]`
  Runs a recipe of operations deterministically. Same input, recipe and engine versions, same bytes.
- `ops [--json]`
  Lists the operations, their parameter schemas and the engines.
- `--help`, `--version`; `<command> --help` for one command's options. With `--json`, help is a JSON document whose `usage` field holds the text.

## Exit codes

| Code | Meaning                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success                                                                                                                      |
| 1    | Unexpected internal error                                                                                                    |
| 2    | Invalid input                                                                                                                |
| 3    | Cap refused: the run's cap or a spend limit across runs (also a dry-run forecast over either)                                |
| 4    | Provider error (missing `AI_GATEWAY_API_KEY`, or every candidate failed)                                                     |
| 5    | QA found nothing                                                                                                             |
| 6    | The target's validator rejected what was written                                                                             |
| 7    | Licence refused (`license_refused`): the provider's output grant does not let the target declare the output; nothing written |

## Environment and network

- Reads `AI_GATEWAY_API_KEY` (Vercel AI Gateway key), from the environment only. Not needed for `--dry-run` or `--provider-script`.
- Records every paid call in a spend ledger shared across runs (`ASSETFORGE_SPEND_LEDGER`, default `~/.local/state/assetforge/spend.jsonl`) and refuses a call (exit 3) that would cross the daily limit (`ASSETFORGE_DAILY_LIMIT_USD`, default $10) or the work item's limit (`ASSETFORGE_WORK_ITEM_LIMIT_USD`, default $5). Name your work item with `ASSETFORGE_WORK_ITEM` or `--work-item`, for example the Objective; in a Factory worker it defaults to the Objective from `FACTORY_ISSUE`. `--dry-run` shows the spend left under each. Scripted runs (`--provider-script`) are not counted or refused by these limits; their `--cap` still applies. Never raise a limit yourself; ask the human.
- Reaches only `ai-gateway.vercel.sh` (HTTPS), and only for `plan`, `apply`, `stage`, `generate-sheet` and `import` (without `--no-propose`), or their MCP equivalents, never with `--dry-run` or `--provider-script`. `pick` and `write-families` run the target profile's own validator command locally. A sandbox can allow just that host.

## The rule (PRD section 5.7)

**Agents may plan, apply authorized generation plans, stage candidates, generate and import sheets (and dry-run first to check cost). Agents never run `pick`, never confirm a grouping or run `write-families`, and never approve. A human picks, and Assetforge never marks anything approved.** Report the staged run or import directory and the candidate IDs to the human instead.

## Suggested flow

1. `stage --dry-run --json` to check the plan and cost forecast.
2. `stage --json` to generate and stage candidates.
3. Hand the run directory and candidate IDs to the human.
