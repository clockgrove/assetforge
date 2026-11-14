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

Paid commands reserve every call against their `--cap` (USD) and against the spend ledger (see [Environment](#environment)). Commands that stage write under `.assetgrove/` in the working directory by default; only `bible init`, `bible preset`, `pick` and `write-families` write into the target.

### `bible`

```text
bible describe --bible <BIBLE.md> [--json]
bible init --directory <target repository> --world <name> --preset <preset> [--json]
bible preset --bible <BIBLE.md> --preset <preset> [--json]
```

`describe` reads a world's art constitution (art direction, bounds, anchors, presets, identity locks) as JSON. `init` writes into the target repository a bible at `.assetgrove/art-direction/BIBLE.md` with its presets, an `art-direction` skill under `.claude/skills/` and `.agents/skills/`, and a prompt template at `.assetgrove/prompts/default.md`; it refuses to overwrite any of them. `preset` rewrites the bible's look and tone from one of its presets and keeps the world's palette, anchors and identity locks; `apply` then refuses plans made from the earlier bible. The presets are `cozy-storybook`, `flat-cartoon-kids` and `dark-gritty-isometric`. Calls no model and spends nothing.

### `plan`

```text
plan --spec <spec.json> --bible <BIBLE.md> --profile <profile.json> --out <plan.json> [--brief <brief.json>] [--settings <settings.json>] [--template <template.md>] [--routes <routes.json>] [--identity-mode <off|shadow|enforce>] [--work-item <label>] [--provider-script <module>] [--json]
```

Compiles a reviewable generation plan into `--out` and never generates images. With a provider (`AI_GATEWAY_API_KEY` or `--provider-script`), the configured compiler LLM writes the prompt and negatives from the repository's templates in one model call; without one, a marked deterministic template fallback is recorded. `--identity-mode` overrides the profile's identity mode for a character with an identity lock, and the forecast includes the scoring calls. Show the plan's prompts, clamps and cost forecast to the human. Writes only the plan file.

### `apply`

```text
apply <plan.json> [--auto-approve] [--out <runs directory>] [--work-item <label>] [--provider-script <module>] [--json]
```

Generates exactly a saved plan. It refuses stale bible, template and identity inputs, and a plan whose `approved` field a human has not set to `true`, unless `--auto-approve` is given for an unattended campaign. Approval authorizes the generation spend only; the outputs stay pending review. Paid gateway calls; needs `AI_GATEWAY_API_KEY` or `--provider-script` (exit 4 without either). Stages the run under `--out` (default `.assetgrove/runs`), never in the target.

### `mcp`

```text
mcp [--work-item <label>] [--provider-script <module>]
```

Serves the tools `bible_describe`, `bible_init`, `bible_preset`, `plan` and `apply` over MCP stdio with the official MCP SDK; each does what its command does, and file paths are local to the server. Stdout carries the protocol, so it prints no JSON document; logs go to stderr. Spends and writes as `plan`, `apply` and `bible` do.

### `materials`

```text
materials --albedo <painted.png> --spec <spec.json> --profile <profile.json> --derivation <derivation.json> --out <directory> [--cap 5] [--routes <routes.json>] [--work-item <label>] [--digital-source-type <IPTC code or URI>] [--provider-script <module>] [--dry-run] [--json]
```

Derives the material channels the profile's `style.materials` requests from a painted albedo, checks alignment and temporal stability, writes native-resolution renditions into `--out`, runs the target's compression and lit previews, and judges the flat and lit images with vision QA. Paid gateway calls (vision QA and any model-assisted channel). Rejected materials exit 5 and stay unapproved. Never writes into the target.

### `stage`

```text
stage --spec <spec.json> --bible <bible.json> --profile <profile.json> [--candidates 4] [--cap 5] [--routes <routes.json>] [--runs .assetgrove/runs] [--work-item <label>] [--provider-script <module>] [--dry-run] [--json]
```

Generates candidates within the cap and stages only those that pass QA, with reasons and provenance, in a run directory under `--runs`. `--dry-run` prints the planned calls, the cost forecast and the spend left under the ledger's limits, writes nothing and needs no key. Image kinds make paid gateway calls. A `character-3d` spec makes rigged, animated `.glb` candidates from the subject's approved turnaround: its 3D calls go to Tripo (`TRIPO_API_KEY`) and its identity call to the gateway. A sprite-strip spec needs an approved `keyPose`. Never writes into the target.

### `pick`

```text
pick --run <run directory> --candidate <id> --target <target directory> [--json]
```

Writes the chosen candidate and its manifest into the target with review pending, then runs the target profile's validator command locally when it declares one (exit 6 when it rejects). Refuses, before writing, an output the target's licence cannot declare (exit 7). Calls no model and spends nothing. Only a person runs it.

### `rig`

```text
rig --model <model.glb> --provenance <provenance.json> --spec <spec.json> --profile <profile.json> [--runs .assetgrove/runs] [--json]
```

Re-rigs an existing 3D character, such as a picked candidate, on the target's shared skeleton (`model3d.rig`), generates the clips its gait profiles and motions declare, checks each clip, and stages a one-candidate run with renders under `--runs` for a person to pick. Calls no model and spends nothing. Exits 5 when the result fails QA.

### `lod`

```text
lod --run <run dir> --candidate <id> [--profile <profile.json>] [--runs .assetgrove/runs] [--json]
lod --model <model.glb> --provenance <provenance.json> --spec <spec.json> --profile <profile.json> [--runs .assetgrove/runs] [--json]
```

Makes the detail-level chain the profile declares (`model3d.lods`) and a rendition per quality tier (`model3d.tiers`) from a staged candidate or a given `.glb`. Each lower level keeps the skeleton, skin weights, clips and UVs, is checked against the full model, and is left out with a reason when it fails. Stages a one-candidate run under `--runs` for a person to pick. Calls no model and spends nothing. Exits 5 when the chain fails QA.

### `look-dev`

```text
look-dev --model <model.glb> --provenance <provenance.json> --spec <spec.json> --bible <bible.json> --profile <profile.json> [--cap <usd>] [--routes <routes.json>] [--runs .assetgrove/runs] [--work-item <label>] [--provider-script <module>] [--dry-run] [--json]
```

Repaints a picked 3D character's base colour on its own UVs in the look the bible's approved references define, writes fur groom maps and tint textures per season the profile declares (`model3d.groom`), gives the eyes a glossy material and mask, and checks them. Stages a one-candidate run with before-and-after renders under `--runs` for a person to pick. Paid gateway calls; the cap defaults to the profile's `model3d.lookdev.capUsd` or $3. Exits 5 when the result fails its checks.

### `import`

```text
import --sheet <sheet.png> --profile <profile.json> --asset <id> --tool <name> [--bible <bible.json>] [--subject <name>] [--hints idle,walk-right,...] [--frames <count>] [--grid <columns>] [--components] [--no-propose] [--cap 5] [--work-item <label>] [--routes <routes.json>] [--imports .assetgrove/imports] [--digital-source-type <IPTC code or URI>] [--provider-script <module>] [--lock-bible <BIBLE.md>] [--identity-mode <off|shadow|enforce>] [--json]
```

Slices a contact sheet from any tool (`--tool` names it) into frames under `--imports`, removes the background to the profile's style, and has a vision model propose animation families in `<import>/grouping.json` with status `proposed`. `--no-propose` skips that paid call. With `--lock-bible`, a locked subject's sheet is also scored against its identity lock, one paid call unless `--identity-mode off`. With `--frames`, a sheet that does not slice into exactly that many figures is refused (exit 2) before any model call. Never writes into the target.

### `generate-sheet`

```text
generate-sheet --spec <spec.json> --bible <bible.json> --profile <profile.json> [--cap 5] [--routes <routes.json>] [--imports .assetgrove/imports] [--lock-bible <BIBLE.md>] [--identity-mode <off|shadow|enforce>] [--brief <brief.json>] [--work-item <label>] [--provider-script <module>] [--dry-run] [--json]
```

Has the model draw a whole animation cycle as one sheet within the cap, then imports it as `import` does, with a proposed grouping for a person to confirm. A sheet that does not slice into the spec's `frames.count` figures exits 5; the sheet and its record are kept in the import directory. `--brief` adds the author's brief to the prompt; `--lock-bible` and `--identity-mode` score the sheet as `import` does, inside the forecast and the cap. Paid gateway calls. Never writes into the target.

### `write-families`

```text
write-families --import <import directory> --target <target directory> [--grouping <import>/grouping.json] [--jitter-bound 1] [--json]
```

Writes one strip and manifest per family of a grouping whose status a person set to `confirmed` into the target with review pending, registered within the jitter bound in pixels. Runs the target's validator (exit 6 when it rejects), and refuses an output the target's licence cannot declare (exit 7) or a sheet the identity lock filtered. Calls no model and spends nothing. Only a person runs it.

### `identity-eval`

```text
identity-eval [--bible <BIBLE.md>] --cases <cases.json> [--profile <profile.json>] [--log <identity-eval.jsonl>] [--cap 5] [--routes <routes.json>] [--work-item <label>] [--provider-script <module>] [--json]
```

Scores every case of a local labelled image set against its subject's identity lock and reports accuracy per threshold, the recommended threshold, accuracy at the profile's threshold and agreement with the cases' QA verdicts. Paid gateway calls. Writes one JSON line per case to `--log` and nothing else; never filters or approves. Keep the set and the log local.

### `identity-check`

```text
identity-check --bible <BIBLE.md> [--subject <name>]... [--routes <routes.json>] [--cap 5] [--work-item <label>] [--provider-script <module>] [--json]
```

Asks whether each identity record's written features, proportions and palette agree with the record's own approved reference images, for every identity in the bible or each named subject. Paid gateway calls; writes nothing. Exits 1 when any record disagrees or could not be checked; enforce mode does not filter with that record until a person fixes its text or references.

### `animation-qa`

```text
animation-qa (--strip <strip.png> --family <name> --profile <profile.json> | --import <import directory>) [--out .assetgrove/animation] [--subject <name>] [--spec <spec.json>] [--anchor x,y] [--no-vision] [--cap 5] [--routes <routes.json>] [--work-item <label>] [--provider-script <module>] [--dry-run] [--json]
```

Checks one strip, or every family `write-families` wrote from an import, against its motion template and for loop and continuity on pixels. Within the cap, vision calls judge identity flicker between consecutive frames and holes inside the figure; `--no-vision` skips both and spends nothing. Writes a QA report, an onion-skin sheet and a looping preview per family into `--out`, never into the target. Exits 5 when any check fails; each failure names its frame.

### `fix-frame`

```text
fix-frame --strip <strip.png> --family <name> --profile <profile.json> --frame <n> (--from <n> | --key-pose <image>) --out <directory> [--subject <name>] [--spec <spec.json>] [--note <text>] [--provenance <strip>.provenance.json] [--bible <bible.json>] [--anchor x,y] [--cap 2] [--routes <routes.json>] [--work-item <label>] [--provider-script <module>] [--dry-run] [--json]
```

Regenerates one frame (1-based) of a strip with one paid reference-guided edit call, from an approved neighbour frame or the approved key pose. Only that frame changes. Writes the fixed strip, its provenance with a fixes entry, and its QA report and previews into `--out`; never writes into the target or sets a review value. A provenance file that is not the strip's own record is refused (exit 2) before the call.

### `op`

```text
op <operation> <input...> --out <path> [--params <json object>] [--profile <profile.json>] [--digital-source-type <IPTC code or URI>] [--json]
```

Runs one image operation (`ops` lists them) over the inputs and writes the outputs and a provenance record to `--out`: a file for one output, otherwise a directory. The profile supplies the style and frame size. Local: no model call, no spend.

### `recipe`

```text
recipe <recipe.json> <input...> --out <path> [--profile <profile.json>] [--digital-source-type <IPTC code or URI>] [--json]
```

Runs a recipe file's operations in order over the inputs and writes the outputs and a provenance record to `--out`. Deterministic: the same input, recipe and engine versions give the same bytes. Local: no model call, no spend.

### `ops`

```text
ops [--json]
```

Lists every operation with its summary, parameters and engines. Local.

## Exit codes

| Code | Meaning                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success                                                                                                                                                              |
| 1    | Unexpected internal error; also `identity-check` when a record disagrees or could not be checked                                                                     |
| 2    | Invalid input, including an unknown option                                                                                                                           |
| 3    | Cap refused: the run's cap or a spend limit across runs (also a dry-run forecast over either)                                                                        |
| 4    | Provider error: no `AI_GATEWAY_API_KEY` where a gateway call is needed, no `TRIPO_API_KEY` for a `character-3d` stage, or every candidate failed to generate         |
| 5    | QA found nothing: no candidate passed, or a check failed (`animation-qa`, `materials`, `rig`, `lod`, `look-dev`, a generated sheet with the wrong number of figures) |
| 6    | The target's validator rejected what `pick` or `write-families` wrote                                                                                                |
| 7    | Licence refused (`license_refused`): the provider's output grant does not let the target declare the output; nothing written                                         |

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
