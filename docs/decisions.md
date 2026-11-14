# Decisions

This file lists the decisions in force in Assetgrove and the reason for each.

## Language and tooling

Assetgrove is TypeScript on Node 24, managed with pnpm. Node runs the `.ts` sources directly with its built-in type stripping, so development has no build step, the code uses erasable syntax only (no enums, namespaces or parameter properties), and imports name their `.ts` files. A game that already uses Node, pnpm and TypeScript runs Assetgrove with no new runtime.

- **pnpm** is pinned through `packageManager` and enabled with corepack. CI installs with `pnpm install --frozen-lockfile --ignore-scripts`, so no dependency may need an install script.
- **Commands:** `pnpm check` runs Prettier, ESLint (typescript-eslint) and `tsc --noEmit`. `pnpm test` runs `node:test` over `test/**/*.test.ts`, offline, with the scripted provider. `pnpm test:real` runs the opt-in real-provider checks in `test/real/`, which skip without their keys (`AI_GATEWAY_API_KEY`, `TRIPO_API_KEY`).
- **Runtime dependencies:** `ai` (the Vercel AI SDK, imported only by `src/gateway/vercel.ts`), `pngjs` and `jpeg-js` (pure-JavaScript image codecs), `yaml` (the bible's front matter), `@modelcontextprotocol/server` (the MCP server), `gltf-validator` (the Khronos glTF validator in 3D QA) and `meshoptimizer` (mesh simplification for detail levels).
- **TypeScript** stays on 6.0, the newest version typescript-eslint supports.

## Release-age exclusion for the `ai` SDK

`pnpm-workspace.yaml` lists `ai@7.0.165` and its three `@ai-sdk/*` packages, at exact versions, under `minimumReleaseAgeExclude`. pnpm's default release-age policy refuses versions published too recently, and the gateway adapter is written and checked against this release. The exclusion names exact versions only, so any other version, including a later update, still waits out the window. Once these versions are older than the window, the exclusion can go; `pnpm install` must then leave the lockfile unchanged.

## Packaging

The package is `@clockgrove/assetgrove`. It ships compiled JavaScript, because Node refuses to strip types inside `node_modules`.

- `tsc -p tsconfig.build.json` builds `dist/`, with `rewriteRelativeImportExtensions` turning `.ts` imports into `.js`. The repository itself runs the sources directly.
- The package ships `dist/`, `skills/`, the README and the LICENSE.
- The version is `0.0.0` in the repository.
- Publishing (the npm org, trusted publishing and a release workflow) is a maintainer's step and is not in the repository. The package is published at 1.0.

## CLI contract

Every command follows one contract, so scripts and agents can drive Assetgrove without parsing prose.

- With `--json`, stdout is one JSON document: `ok`, `exitCode`, `command` and, on refusal, `error` with `code` and `message`. Logs go to stderr. Nothing prompts.
- Exit codes:
  - 0: success.
  - 1: unexpected internal error.
  - 2: invalid input.
  - 3: cap refused, by the run's cap or a cross-run spend limit, including a dry-run forecast over either.
  - 4: provider error.
  - 5: QA found nothing.
  - 6: the target's validator rejected what was written (`pick` or `write-families`).
  - 7: licence refused (`license_refused`): the provider's output grant does not let the target declare the output, and nothing is written.
- `--dry-run` (on `stage`, `generate-sheet`, `animation-qa`, `fix-frame` and `materials`) prints the planned calls and the forecast, spends nothing and needs no key.
- `--provider-script` runs a scripted provider for offline runs.

## MCP server on the official SDK

`assetgrove mcp` is served by the official TypeScript MCP SDK, `@modelcontextprotocol/server` 2.4.0 (Apache-2.0), over its stdio transport. The SDK negotiates the protocol revision and validates arguments against each tool's input schema, where hand-written protocol code would fall behind the protocol. It brings `@modelcontextprotocol/core` 2.4.0 (Apache-2.0) and `zod` (MIT); none of them has an install script, and 2.4.0 needs no release-age exclusion. The tool schemas stay plain JSON Schema, wrapped with the SDK's `fromJsonSchema`, so `tools/list` advertises them unchanged.

## Generation constitutions

Art direction lives in a target-owned Markdown bible with validated YAML front matter, prose rationale, and Do's and Don'ts. Palette, outline, lighting, fog, saturation and value bounds use DTCG 2025.10 typed tokens; art-specific axes stay in the art schema. The JSON profile, spec and recipe formats stay JSON, and `yaml` is pinned to 2.9.1 because the bible format requires YAML.

The target owns an Agent Skill that links the bible and starting presets. DESIGN.md contributes UI colour context only; Assetgrove does not extend its format with art direction. Prompt templates are copied into the target repository on explicit initialization (`assetgrove bible init`) and versioned there. `plan` records the compilation and model inputs; `apply` checks their hashes and authorizes generation spend without approving an asset.

## Media transformation core

Operations are declared once, by name and parameter schema, in `src/transform/operations.ts`, and engines implement them behind the `ImageEngine` adapter. The in-house engine is `assetgrove-raster`; its version is bumped whenever an operation's output bytes change, so provenance names what made each file.

- Recipes are JSON (`format: "assetgrove-recipe/1"`). The parameter schemas use a small JSON Schema subset kept in the repository, so recipes need no parser or validator dependency.
- Provenance steps are chained by pixel hashes, so intermediate images are never encoded. Sources and written files also record their file SHA-256. The record holds no time, so reruns are byte-identical.
- WebP output is lossless VP8L from an in-house encoder, because it is deterministic and needs no native dependency.
- The sheet import runs on these operations.

## Sheet generation first

The model generates a whole animation cycle as one contact sheet, because a whole sheet keeps identity consistent; a per-frame reference edit is the fallback for fixing a single frame. Sheets made by other tools take the same import path. A vision model proposes the families, order and mirror pairs, and the author confirms them by setting the grouping file's status to `confirmed`, which Assetgrove never does itself. Registration pins the feet baseline and centre of mass to the anchor with one common scale, and refuses a family whose measured jitter exceeds the bound (1 px by default). Details are in [sheet-import.md](sheet-import.md).

## Style profile

Assetgrove is not tied to one visual style. The target profile's optional `style` (alpha mode, colour rule, edges) decides post-processing: soft 8-bit alpha and full colour for a painterly world, binary alpha, crisp edges or a palette for flat-cartoon and pixel-art worlds. Without a style, the sheet import uses soft alpha and full colour. `stage` post-processes still and strip candidates to binary alpha and the bible palette whatever the style says.

## Animation from an approved key pose

A strip starts from a key pose, and each frame is a reference-guided edit of it. A sprite-strip spec must name an author-approved `keyPose` and an `animationFamily`, and Assetgrove refuses a strip spec without them before any spend. To make one, stage a `still` of the pose, choose one of the staged candidates (or any author-made image), then stage the strip with that file as `keyPose`. The author approves the pose before any frame is edited, so frames inherit an identity a person has accepted.

## Picking

The person picks. `assetgrove stage` stages only QA-passing candidates with their reasons, and `assetgrove pick` writes the chosen one with the review field at the profile's pending value. Assetgrove never writes any other review value, because approval is human.

## Decision models for QA

Identity scoring uses a typed decision model. Other image checks do not:

- **Strips:** a whole cycle is generated as one sheet and checked with pixel QA, one vision check for identity flicker and a budgeted per-frame fix, so per-frame checks need no decision model.
- **Perspective:** perspective stays in the candidate's vision QA. That call costs a small fraction of a candidate, authors rely on its written reason, and there is no labelled perspective data to choose a decision model or cutoff from.
- **Identity flicker:** stays a vision check until enough labelled flicker data exists to choose a decision model for it.

## Identity lock scoring

Every candidate of a character with an identity lock is scored against its identity record by a typed decision model (a five-level Score question) through the gateway's `identity` route. The default model is `perplexity/pplx-decider-v1.2`, with `openai/gpt-6-luna-decisions` as the alternate; pplx is the more accurate of the two and costs a fraction as much. The default threshold is 0.68, set where wrong-character crops stop passing on a labelled identity set. The threshold applies to the score, not to the model's confidence, because decision-model confidence sits between 0.5 and 0.8 even on correct answers; confidence is logged.

## Shadow mode is the identity default

Scoring runs in shadow mode by default: it records the score beside QA and filters nothing. Filtering (`identity.mode: "enforce"`) is opt-in per target profile, and the default stays shadow until a question meets the [identity lock bar](#identity-lock-bar). Scoring never approves.

## No enforce mode for look-alike casts

Do not use enforce mode for a cast of look-alike characters. A lock with one reference can tell a character's kind from something else, but not one look-alike cast member from another: on a labelled look-alike set its scores separate them no better than chance, whichever decision or vision model answers.

## Identity records are checked against their references

In enforce mode, each identity record is first checked on the `identity-check` route: does its written signature agree with its own approved references? A record that disagrees is untrusted: its candidates are scored in shadow and never filtered until a person fixes the text or the references. A check that cannot run fails closed. Models trust the text, so a wrong record rejects the real character and accepts a look-alike.

## Identity lock bar

Enforce mode needs a measured bar: ROC AUC ≥ 0.95, false accepts ≤ 5% and false rejects ≤ 10% (`IDENTITY_ENFORCE_BAR`, reported by `identity-eval`). Every negative kind (drift, generic, look-alike) and every cast must meet it on 2D cases of trusted records, at a threshold fixed before the run. Only held-out cases count: positives and drift added after the prompt was last worded, never used to word it. No question meets the bar on held-out cases yet, so shadow mode stays the default, and enforce mode and the cast question are not recommended for a look-alike cast.

## Identity cast question: only what the animation implies is excused

`identity.question: "cast"` is opt-in. It judges a candidate as a choice among the whole cast (every identity record in the same bible) and also asks whether it is on-model for the subject against the subject's approved references, which win where the written record disagrees. The score is p(subject) × p(on-model). The default threshold stays 0.68 for every question; use 0.5 with `cast`, the threshold it is measured at. One call sends at most 16 images (`IDENTITY_CAST_MAX_IMAGES`), so a bible with more than 15 identity records is refused.

The on-model step excuses only what the pose and the named animation imply, and its wording names no species or cast:

- **Excused:** a back arched or hunched; a tail lowered, raised, swung or curled; a head turned, tilted or lowered; limbs bent, lifted, stretched out or overlapping; wings spread or folded; eyes closed in a blink; a crest or ears swept by motion; a body that looks deeper or shorter-legged because the legs bend or it turns; parts hidden or foreshortened by the view; background between the limbs. A held prop or food, or an open mouth, is excused only when the named animation implies it (eating, carrying, calling). The model lists these as `poseDifferences`, which never lower the score.
- **Deviations:** a region in a different hue, or clearly lighter, darker or more muted as if repainted (shading and lighting are not a colour change); a marking missing, added or moved; a see-through hole; a different count of repeated marks on a part fully in view; proportions the pose does not produce; a signature feature missing, added or changed.
- **Stretch:** a pose bends the body at the spine and joints but never rescales the figure. A whole body, or a rigid part such as the head, an eye or a beak, longer or shorter in one direction than the references show is a stretch, however the figure is tilted.

Animation posture is not drift, while a change of hue, marking or proportion is. A body stretched about 1.3× in a strongly posed frame can still pass.

## Characters are real-time 3D

Characters are rigged real-time 3D models with an animation clip per family. Zoom, lighting and camera come from the game's renderer, and a new animation is a clip on the same rig rather than new art. The 2D path (sheet generation and import, the transformation core, loop QA, identity lock) serves props, terrain, effects, UI and targets that use sprites.

## Missing clips are reported, not faked

Without a skeleton template, a character uses the provider's auto-rig and its clip library, retargeted per family. A family the library has no close clip for is reported as missing. It is never faked, and the candidate is not refused for it.

## Shared rig and generated gait

Characters of one kind can share a skeleton template fitted to each model, with locomotion generated from a gait profile the target declares. QA checks foot contact, joint limits and skinning. For any kind whose target declares a template, this replaces the provider's auto-rig and clip library, because a provider's library walk does not move the way each species moves.

## `lookdev-markings` is advisory

`lookdev-markings` runs and records every measurement, but it never filters a look-dev candidate, and a drift does not make the run exit 5. Its reason is marked `shadow` and starts by saying the check is advisory and why; the run summary shows its verdict as "not filtered". The check measures each marking in boxes a vision model draws, and on the same code it names a different set of drifting markings on each run, so it cannot make a pass or fail call. It filters only once repeated measurements on the same renders name the same drifting markings, which takes stable boxes, not a looser threshold. A person judges the compare images.

## 3D identity results are provisional

`identity-eval` reports 3D cases apart and marks them provisional: no threshold or bar rests on them. Do not use enforce mode on 3D characters, because at the shipped thresholds no question separates lit renders of the right character from their drift.

## Licence of generated output

Assetgrove writes the licence the target profile declares and records the models, route and provider terms in provenance.

## Provider output grants

Provider terms differ on who owns an output, so each route declares its `outputGrant` (`license`, `plan`, `commercial`, `relabel`, `attribution`), every call records it, and the provenance carries the most restrictive combination over its calls. The provenance's `license` is the target's licence only when the grant allows relabelling; otherwise it is the granted licence, when that licence is commercial and the target lists it in `acceptedLicenses`. Anything else is refused at hand-off (`pick`, `write-families`) with exit 7 (`license_refused`) before a file is written. Staging is unaffected, so free-credit trials that never reach a target still run.
