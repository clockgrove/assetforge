---
name: assetgrove
description: Load when you need the Assetgrove CLI to plan, generate, import, check or transform game art within a cost cap and stage the results, with QA and provenance, for a human to pick. Lists every command with its options, what it spends and whether it writes into the target, plus the exit codes, environment, network hosts and the steps only a person takes.
---

# Assetgrove

Assetgrove generates game assets through generation models and stages the ones that pass QA, with provenance, for a human to review. It also imports contact sheets, checks animation and identity, and transforms images locally.

Run it as `npx @clockgrove/assetgrove@<version> <command>`, or as `assetgrove` (`pnpm exec assetgrove`) when the game pins it as a dev dependency.

## Contract

- Pass `--json` to every command except `mcp`. Stdout is exactly one JSON document with `ok`, `exitCode`, `command` and, on refusal, `error: { code, message }`. A spend-limit refusal also carries `error.limit`.
- Logs go to stderr. It never prompts.
- `assetgrove --help` lists the commands; `assetgrove <command> --help` prints one command's usage. With `--json`, help is a JSON document whose `usage` field holds the text. `--version` prints the version as plain text.

## The rule

**Agents may plan, apply authorized generation plans, stage candidates, generate and import sheets, check animation and identity, fix frames and run local operations, dry-running paid commands first to check cost. Agents never run `pick`, never confirm a grouping, never run `write-families` and never approve. A human picks, and Assetgrove never marks anything approved.** Report the run or import directory and the candidate IDs to the human instead.

Only a person:

- runs `pick` and `write-families`;
- sets a grouping's `status` to `confirmed`;
- sets a plan's `approved` field, or authorizes an unattended campaign that runs `apply --auto-approve`;
- fixes an identity record that `identity-check` reports as disagreeing;
- raises a spend limit. Never raise one yourself; ask the human.

## Suggested flow

1. `stage --dry-run --json` to check the planned calls and the cost forecast.
2. `stage --json` to generate and stage candidates.
3. Hand the run directory and candidate IDs to the human.

For repository-owned art direction, `bible init` the target's constitution, `bible describe` it before writing a brief, then `plan`, show the plan to the human, and `apply` it once they approve. See [generation knobs](https://github.com/clockgrove/assetgrove/blob/main/docs/generation-knobs.md) for the brief, run settings and target template formats.

## Commands

Every command, with its options and the MCP tool that serves it, is in [the command reference](references/commands.md). Paid commands reserve every call against their `--cap` (USD) and against the spend ledger (see [Environment](#environment)). Commands that stage write under `.assetgrove/` in the working directory by default; only `bible init`, `bible preset`, `pick` and `write-families` write into the target.

## Exit codes

| Exit | Meaning                 | Codes                                                                                                                                                                                                                   |
| ---- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | success                 |                                                                                                                                                                                                                         |
| 1    | internal error          | `internal_error`                                                                                                                                                                                                        |
| 2    | invalid input           | `invalid_input`, `settings_invalid`, `key_tracked`, `format_unsupported`, `extension_unavailable`, `extension_refused`, `extension_conflict`, `route_unavailable`, `plan_changed`, `run_in_progress`, `command_refused` |
| 3    | spend refused           | `cap_refused`, `provider_limit_undeclared`, `provider_limit_mismatch`, `spend_hold`                                                                                                                                     |
| 4    | provider error          | `provider_error`                                                                                                                                                                                                        |
| 5    | QA found nothing        | `qa_found_nothing`                                                                                                                                                                                                      |
| 6    | written output rejected | `validator_rejected`, `handoff_check_failed`                                                                                                                                                                            |
| 7    | licence refused         | `license_refused`                                                                                                                                                                                                       |
| 8    | a person must confirm   | `confirmation_required`, `confirmation_declined`                                                                                                                                                                        |
| 9    | prompt refused          | `prompt_refused`                                                                                                                                                                                                        |

Decide on the exit and `error.code`, never on the message. What the commands return today:

- 1: an unexpected internal error; also `identity-check` when a record disagrees or could not be checked (no `error`).
- 2: invalid input, including an unknown option.
- 3: the run's cap or a spend limit across runs (also a dry-run forecast over either).
- 4: no `AI_GATEWAY_API_KEY` where a gateway call is needed, no `TRIPO_API_KEY` for a `character-3d` stage, or every candidate failed to generate.
- 5: no candidate passed, or a check failed (`animation-qa`, `materials`, `rig`, `lod`, `look-dev`, a generated sheet with the wrong number of figures).
- 6: the target's validator rejected what `pick` or `write-families` wrote.
- 7: the provider's output grant does not let the target declare the output; nothing written.

## Environment

- `AI_GATEWAY_API_KEY`: the Vercel AI Gateway key, from the environment only. Not needed for `--dry-run` or `--provider-script`.
- `TRIPO_API_KEY`: the Tripo key, from the environment only, for the 3D calls of a `character-3d` stage.
- `--provider-script <module>` answers every model call from a module whose default export is `{ image, vision }`. Its calls cost nothing and the ledger neither counts nor refuses them; `--cap` still applies.
- Every paid call is recorded in a spend ledger shared across runs: `ASSETGROVE_SPEND_LEDGER`, default `$XDG_STATE_HOME/assetgrove/spend.jsonl` or `~/.local/state/assetgrove/spend.jsonl`. A call that would cross the daily limit (`ASSETGROVE_DAILY_LIMIT_USD`, default $10, last 24 hours) or the work item's limit (`ASSETGROVE_WORK_ITEM_LIMIT_USD`, default $5) is refused with exit 3. A target profile's `spend.dailyLimitUsd` and `spend.workItemLimitUsd` apply too; the stricter of each pair wins. `--dry-run` shows the spend left under each.
- Name the work item with `--work-item` or `ASSETGROVE_WORK_ITEM`. Without one, a CI work item from `FACTORY_ISSUE` (digits only) is used. With no work item, only the daily limit applies.
- When `FACTORY_ISSUE` is set, the default ledger is `assetgrove-spend.jsonl` in `$FACTORY_STATE_DIR`, or else in the temp directory.

## Network

- The Vercel AI Gateway at `ai-gateway.vercel.sh` (HTTPS), for `plan` with a key, `apply`, the `mcp` tools `plan` and `apply`, `materials`, `stage`, `look-dev`, `import` (unless `--no-propose` and no identity scoring), `generate-sheet`, `identity-eval`, `identity-check`, `animation-qa` (unless `--no-vision`) and `fix-frame`. When `FACTORY_GATEWAY_URL` is set, these calls go to `<FACTORY_GATEWAY_URL>/v4/ai` instead.
- Tripo at `api.tripo3d.ai` (HTTPS), plus the model download URL each finished Tripo task returns, only for `stage` with a `character-3d` spec.
- Nothing is reached with `--dry-run` or `--provider-script`. `bible`, `pick`, `rig`, `lod`, `write-families`, `op`, `recipe` and `ops` reach no host; `pick` and `write-families` run the target profile's validator command locally.
