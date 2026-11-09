# Assetforge

Assetforge generates game assets — sprites, animation strips, and later video, audio and 3D — through image and video generation models, and hands them to a game's own asset pipeline with full provenance.

It is a development tool. A game repository never depends on it at runtime: Assetforge writes files and their manifests in the format the game declares, and the game's own validator and human review decide what enters the game.

## How it works

1. **Spec, not freehand.** Each request starts from the target asset's spec (asset, animation family, frame count and size, anchor) and the world's style bible (approved reference images, palette, perspective).
2. **Candidates.** Models behind one gateway adapter produce several candidates per request, within a per-run cost cap.
3. **Post-processing to spec.** Background to true alpha, crop and scale to the frame grid, palette and pivot alignment.
4. **Vision QA.** A vision model checks each candidate against the spec and the references; only passing candidates are shown.
5. **Operator pick.** A person picks and approves. Nothing is accepted automatically.
6. **Hand-off.** The chosen files and their provenance are written into the target repository for its pipeline; media is stored with Git LFS.

Animation is generated as a whole contact sheet per cycle, sliced and registered into frames; a single bad frame is fixed by a reference-guided edit.

## Install in a game repository

Assetforge is published as `@clockgrove/assetforge`. Pin an exact version as a dev dependency. The game never imports it at runtime.

```sh
pnpm add -D --save-exact @clockgrove/assetforge@<version>
export AI_GATEWAY_API_KEY=...   # the Vercel AI Gateway key, from the environment only
pnpm exec assetforge stage --spec stevie-shelter.json --bible bible.json --profile profile.json
pnpm exec assetforge pick --run .assetforge/runs/<run> --candidate c2 --target ../clockgrove
```

Keep the run directory out of Git by adding `.assetforge/` to `.gitignore`.

For one-off use, with only Node 24, run `npx @clockgrove/assetforge@<version> --help`.

`stage` reserves the run's estimated cost against the cap (default 4 candidates and $5; `--candidates`, `--cap`) and refuses a run that would exceed it, then lists only the candidates that passed QA, each with its reasons. `pick` writes the chosen file and its manifest into the target with the review status pending and full provenance, and runs the target's validator. The input formats are in [docs/target-profile.md](docs/target-profile.md); the gateway's models and the default routes are in [docs/models.md](docs/models.md).

For animation, `import` turns a contact sheet into strips: it slices the sheet, removes the background following the target's style profile, registers frames to one baseline and scale, and asks a vision model to propose families. `generate-sheet` has the model draw a whole cycle as one sheet first. The author confirms the grouping, and `write-families` writes one strip per family with review pending. See [docs/sheet-import.md](docs/sheet-import.md).

Every written strip is checked against its family's motion template (idle, walk, sniff, eat, play and shelter ship as data; a target adds its own in its profile) and by loop and continuity QA on pixels, with each failure naming the frame. `write-families` writes an onion-skin sheet and a looping animated WebP preview beside each strip. `animation-qa` adds the identity-flicker vision check within a cost cap, and `fix-frame` regenerates one bad frame by a reference-guided edit from an approved neighbour or the key pose. See [docs/animation.md](docs/animation.md).

Any image, whether generated, imported or hand-made, can be transformed on its own, one operation at a time or with a recipe: `op matte in.png --out out.png`, or `recipe r.json in.png --out out/`. See [docs/transform.md](docs/transform.md).

```sh
pnpm exec assetforge import --sheet sheet.png --profile profile.json --asset stevie --tool "ChatGPT image generation"
pnpm exec assetforge write-families --import .assetforge/imports/<import> --target ../clockgrove
```

## Use from a coding agent (Claude Code, Codex, Copilot)

The package ships a skill at `node_modules/@clockgrove/assetforge/skills/assetforge/SKILL.md`. Copy or link it where your harness reads skills, for example `.claude/skills/assetforge/` or `.agents/skills/assetforge/`.

- Always pass `--json`. Stdout is one JSON document. Logs go to stderr. Assetforge never prompts.
- Run `stage --dry-run` first. It spends nothing and needs no key.
- Set `AI_GATEWAY_API_KEY` in the environment. In a sandbox, allow the host `ai-gateway.vercel.sh`; it is the only host Assetforge reaches.
- Agents stage, humans pick (PRD §5.7). Agents never run `pick` or `write-families` and never confirm a grouping.

## Commands and exit codes

- `stage --spec <spec.json> --bible <bible.json> --profile <profile.json>`: generate candidates within the cap and stage those that pass QA. Options: `--candidates`, `--cap`, `--routes`, `--runs`, `--dry-run` (plan and cost forecast, no spend, no key), `--provider-script <module.js>` (a scripted provider for offline runs), `--json`.
- `pick --run <dir> --candidate <id> --target <dir>`: write the chosen candidate into the target with review pending.
- `import --sheet <sheet.png> --profile <profile.json> --asset <id> --tool <name>`: slice a contact sheet and propose families (`--no-propose` calls no model).
- `generate-sheet --spec <spec.json> --bible <bible.json> --profile <profile.json>`: draw a whole cycle as one sheet within the cap, then import it. Takes `--dry-run` and `--provider-script` like `stage`.
- `write-families --import <dir> --target <dir>`: write the strips of a human-confirmed grouping into the target with review pending.
- `animation-qa --strip <strip> --family <name> --profile <profile.json>` (or `--import <dir>`): motion-template, loop and continuity checks, identity flicker within a cap, onion-skin sheet and loop preview. See [docs/animation.md](docs/animation.md).
- `fix-frame --strip <strip> --family <name> --profile <profile.json> --frame <n> --from <n> --out <dir>`: regenerate one frame by a reference-guided edit within a cap, recorded in provenance.
- `op <operation> <input...> --out <path>`: run one image operation (crop, trim, pad, scale, slice, matte, apply-style, register, join, flip, renditions, convert) on any image, with a provenance record. Options: `--params <json>`, `--profile <profile.json>`.
- `recipe <recipe.json> <input...> --out <path>`: run a recipe of operations, deterministically. See [docs/transform.md](docs/transform.md).
- `ops`: list the operations, their parameter schemas and the engines.
- `--help`, `--version`, and `<command> --help`.

| Code | Meaning                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 0    | Success                                                                                                   |
| 1    | Unexpected internal error                                                                                 |
| 2    | Invalid input                                                                                             |
| 3    | Cap refused (also a dry-run forecast over the cap)                                                        |
| 4    | Provider error (missing `AI_GATEWAY_API_KEY`, or every candidate failed)                                  |
| 5    | QA found nothing                                                                                          |
| 6    | The target's validator rejected what was written                                                          |
| 7    | Licence refused: the provider's output grant does not let the target declare the output (nothing written) |

## Develop

Assetforge runs on Node 24 with pnpm (see [docs/decisions.md](docs/decisions.md)).

- `pnpm install`
- `pnpm assetforge …` runs the TypeScript sources directly.
- `pnpm build` compiles to `dist/` for the package.
- `pnpm check` runs Prettier, ESLint and the type check.
- `pnpm test` runs offline with a scripted provider. It includes a test that packs the package, installs it in a temp dir from the npm registry and runs it.
- `pnpm test:real` runs the opt-in real-provider check, which skips without a key.

## Status

Pre-1.0 and under active design. The first adopter is [Clockgrove](https://github.com/clockgrove/clockgrove)'s Raccoon World.

## License

Assetforge is licensed under the [MIT License](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
