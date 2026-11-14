# Assetgrove

Assetgrove generates game assets — sprites, animation strips, and later video, audio and 3D — through image and video generation models, and hands them to a game's own asset pipeline with full provenance.

It is a development tool. A game repository never depends on it at runtime: Assetgrove writes files and their manifests in the format the game declares, and the game's own validator and human review decide what enters the game.

## How it works

1. **Spec, not freehand.** Each request starts from the target asset's spec (asset, animation family, frame count and size, anchor) and the world's style bible (approved reference images, palette, perspective).
2. **Candidates.** Models behind one gateway adapter produce several candidates per request, within a per-run cost cap.
3. **Post-processing to spec.** Background to true alpha, crop and scale to the frame grid, palette and pivot alignment.
4. **Vision QA.** A vision model checks each candidate against the spec and the references; only passing candidates are shown.
5. **Operator pick.** A person picks and approves. Nothing is accepted automatically.
6. **Hand-off.** The chosen files and their provenance are written into the target repository for its pipeline; media is stored with Git LFS.

Animation is generated as a whole contact sheet per cycle, sliced and registered into frames; a single bad frame is fixed by a reference-guided edit.

## Install in a game repository

Assetgrove is not on npm yet. Its 1.0 release publishes it as `@clockgrove/assetgrove`; until then, check this repository out at a pinned commit and run `node src/cli.ts` with Node 24. The commands below show the published form. The game never imports Assetgrove at runtime.

```sh
pnpm add -D --save-exact @clockgrove/assetgrove@<version>
export AI_GATEWAY_API_KEY=...   # the Vercel AI Gateway key, from the environment only
pnpm exec assetgrove stage --spec fern-shelter.json --bible bible.json --profile profile.json
pnpm exec assetgrove pick --run .assetgrove/runs/<run> --candidate c2 --target ../my-game
```

Keep the run directory out of Git by adding `.assetgrove/` to `.gitignore`.

For one-off use, with only Node 24, run `npx @clockgrove/assetgrove@<version> --help`.

`stage` reserves the run's estimated cost against the cap (default 4 candidates and $5; `--candidates`, `--cap`) and refuses a run that would exceed it, then lists only the candidates that passed QA, each with its reasons. `pick` writes the chosen file and its manifest into the target with the review status pending and full provenance, and runs the target's validator. The input formats are in [docs/target-profile.md](docs/target-profile.md); the gateway's models and the default routes are in [docs/models.md](docs/models.md).

Real-time 3D characters use the same two commands: a `character-3d` spec stages rigged, animated `.glb` candidates from the character's approved turnaround (Tripo by default), QA-filters them with the Khronos glTF validator, the target's polygon, texture, material, bone and LOD budgets, clip and loop checks and turntable renders, and `pick` hands the chosen one to a target whose profile declares `model3d`. See [docs/characters-3d.md](docs/characters-3d.md).

For animation, `import` turns a contact sheet into strips: it slices the sheet, removes the background following the target's style profile, registers frames to one baseline and scale, and asks a vision model to propose families. `generate-sheet` has the model draw a whole cycle as one sheet first. The author confirms the grouping, and `write-families` writes one strip per family with review pending. See [docs/sheet-import.md](docs/sheet-import.md).

Every written strip is checked against its family's motion template (idle, walk, sniff, eat, play and shelter ship as data; a target adds its own in its profile) and by loop and continuity QA on pixels, including a colour halo at the edge, with each failure naming the frame. `write-families` writes an onion-skin sheet and a looping animated WebP preview beside each strip. `animation-qa` adds the identity-flicker and holes vision checks within a cost cap, and `fix-frame` regenerates one bad frame by a reference-guided edit from an approved neighbour or the key pose. See [docs/animation.md](docs/animation.md).

Any image, whether generated, imported or hand-made, can be transformed on its own, one operation at a time or with a recipe: `op matte in.png --out out.png`, or `recipe r.json in.png --out out/`. See [docs/transform.md](docs/transform.md).

```sh
pnpm exec assetgrove import --sheet sheet.png --profile profile.json --asset fern --tool "ChatGPT image generation"
pnpm exec assetgrove write-families --import .assetgrove/imports/<import> --target ../my-game
```

## Use from a coding agent (Claude Code, Codex, Copilot)

The package ships its skills under `skills/`. Install them into your harness with `npx skills add clockgrove/assetgrove`, or copy `node_modules/@clockgrove/assetgrove/skills/assetgrove/` to `.claude/skills/assetgrove/` (Claude Code, Copilot) or `.agents/skills/assetgrove/` (Codex, Copilot).

- Always pass `--json`. Stdout is one JSON document. Logs go to stderr. Assetgrove never prompts.
- Run `stage --dry-run` first. It spends nothing and needs no key.
- Name the work item (`ASSETGROVE_WORK_ITEM` or `--work-item`, for example the Objective; a Factory worker gets its Objective from `FACTORY_ISSUE` by default). Paid calls across runs are capped at $10 a day and $5 per work item by default; see [Spend limits](#spend-limits).
- Set `AI_GATEWAY_API_KEY` in the environment. In a sandbox, allow the host `ai-gateway.vercel.sh`; it is the only host Assetgrove reaches. Inside a Factory stage, `FACTORY_GATEWAY_URL` points calls at Factory's metering relay instead, which holds the real key and counts each call against the Objective's caps.
- Agents stage, humans pick (PRD §5.7). Agents never run `pick` or `write-families` and never confirm a grouping.

## Commands and exit codes

- `stage --spec <spec.json> --bible <bible.json> --profile <profile.json>`: generate candidates within the cap and stage those that pass QA. Options: `--candidates`, `--cap`, `--routes`, `--runs`, `--dry-run` (plan and cost forecast, no spend, no key), `--provider-script <module.js>` (a scripted provider for offline runs), `--json`.
- `pick --run <dir> --candidate <id> --target <dir>`: write the chosen candidate into the target with review pending.
- `rig --model <model.glb> --provenance <provenance.json> --spec <spec.json> --profile <profile.json>`: re-rig an existing 3D character on the target's shared rig (`model3d.rig`) with clips generated from its gait profiles, checked per clip, and staged as a one-candidate run for `pick`. No model is called ([docs/characters-3d.md](docs/characters-3d.md#shared-rig-and-generated-gait)).
- `lod --model <model.glb> --provenance <provenance.json> --spec <spec.json> --profile <profile.json>` (or `--run <run> --candidate <id>`): make the detail-level chain the target profile declares (`model3d.lods`) and a rendition per quality tier (`model3d.tiers`), with textures and side maps within each tier's size. Each level keeps its skeleton, weights, clips and UVs and is checked against the full model. Staged as a one-candidate run for `pick`; no model is called ([docs/characters-3d.md](docs/characters-3d.md#detail-levels-and-tiers)).
- `look-dev --model <model.glb> --provenance <provenance.json> --spec <spec.json> --bible <bible.json> --profile <profile.json>`: give a picked 3D character a base colour in the target's character look on its own UVs, fur groom maps per season, and eyes that catch light; checked, rendered before and after beside the approved turnaround, and staged as a one-candidate run for `pick`. Capped at $3 by default ([docs/look-dev.md](docs/look-dev.md)).
- `import --sheet <sheet.png> --profile <profile.json> --asset <id> --tool <name>`: slice a contact sheet and propose families (`--no-propose` calls no model; `--frames <count>` refuses a sheet that does not slice into that many figures).
- `generate-sheet --spec <spec.json> --bible <bible.json> --profile <profile.json>`: draw a whole cycle as one sheet within the cap, then import it; `--brief <brief.json>` adds the author's brief to the prompt. A sheet that does not slice into the spec's frame count exits 5 and is kept. Takes `--dry-run` and `--provider-script` like `stage`.
- `write-families --import <dir> --target <dir>`: write the strips of a human-confirmed grouping into the target with review pending.
- `animation-qa --strip <strip> --family <name> --profile <profile.json>` (or `--import <dir>`): motion-template, loop and continuity checks, edge halo, identity flicker and holes within a cap, onion-skin sheet and loop preview. See [docs/animation.md](docs/animation.md).
- `fix-frame --strip <strip> --family <name> --profile <profile.json> --frame <n> --from <n> --out <dir>`: regenerate one frame by a reference-guided edit within a cap, recorded in provenance.
- `op <operation> <input...> --out <path>`: run one image operation (crop, trim, pad, scale, slice, matte, apply-style, register, join, flip, renditions, convert) on any image, with a provenance record. Options: `--params <json>`, `--profile <profile.json>`.
- `recipe <recipe.json> <input...> --out <path>`: run a recipe of operations, deterministically. See [docs/transform.md](docs/transform.md).
- `ops`: list the operations, their parameter schemas and the engines.
- `--help`, `--version`, and `<command> --help`.

| Code | Meaning                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------ |
| 0    | Success                                                                                                            |
| 1    | Unexpected internal error                                                                                          |
| 2    | Invalid input, including a reference image that does not decode (an unfetched Git LFS pointer: run `git lfs pull`) |
| 3    | Cap refused: the run's cap or a spend limit across runs (also a dry-run forecast over either)                      |
| 4    | Provider error (missing `AI_GATEWAY_API_KEY`, or every candidate failed)                                           |
| 5    | QA found nothing                                                                                                   |
| 6    | The target's validator rejected what was written                                                                   |
| 7    | Licence refused: the provider's output grant does not let the target declare the output (nothing written)          |

## Spend limits

`--cap` bounds one run. Every paid call (not scripted ones, `--provider-script`) is also recorded in a spend ledger shared by every run on the machine (or in the CI job), and refused (exit 3) before it is made when it would cross a daily limit or the limit of its work item. `--dry-run` shows the spend left under each.

| Variable                         | Default                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ASSETGROVE_SPEND_LEDGER`        | `$XDG_STATE_HOME/assetgrove/spend.jsonl` (`~/.local/state/...`); `assetgrove-spend.jsonl` in `$FACTORY_STATE_DIR` (else `$TMPDIR`) in a Factory worker |
| `ASSETGROVE_WORK_ITEM`           | none (`--work-item <label>` overrides; unset in a Factory worker: `<repo>#<FACTORY_ISSUE>`; otherwise daily limit only)                                |
| `ASSETGROVE_DAILY_LIMIT_USD`     | $10 over the last 24 hours                                                                                                                             |
| `ASSETGROVE_WORK_ITEM_LIMIT_USD` | $5 per work item                                                                                                                                       |

A target profile can set `spend.dailyLimitUsd` and `spend.workItemLimitUsd`; the stricter of the profile and the environment applies. See [docs/target-profile.md](docs/target-profile.md#spend-limits-across-runs).

## Develop

Assetgrove runs on Node 24 with pnpm (see [docs/decisions.md](docs/decisions.md)).

- `pnpm install`
- `pnpm assetgrove …` runs the TypeScript sources directly.
- `pnpm build` compiles to `dist/` for the package.
- `pnpm check` runs Prettier, ESLint and the type check.
- `pnpm test` runs offline with a scripted provider. It includes a test that packs the package, installs it in a temp dir from the npm registry and runs it.
- `pnpm test:real` runs the opt-in real-provider check, which skips without a key.

## Status

Pre-1.0 and under active design.

## License

Assetgrove is licensed under the [MIT License](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
