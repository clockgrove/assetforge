# Decisions

## Language and tooling (assetforge#1, 2026-11-07)

Chosen so the first adopter, Clockgrove (Node 24, pnpm, TypeScript), runs Assetforge with no new runtime.

- **TypeScript on Node 24, no build step in development (the build is only for the package).** Node runs the `.ts` sources directly with its built-in type stripping, so the code uses erasable syntax only (no enums, namespaces or parameter properties) and imports name their `.ts` files. `tsc --noEmit` checks the types.
- **pnpm**, pinned through `packageManager` and enabled with corepack. CI installs with `pnpm install --frozen-lockfile --ignore-scripts`; no dependency needs an install script.
- **Commands:** `pnpm check` runs Prettier, ESLint (typescript-eslint) and `tsc --noEmit`. `pnpm test` runs `node:test` over `test/**/*.test.ts`, offline with the scripted provider. `pnpm test:real` runs the opt-in real-provider checks in `test/real/`, which skip without `AI_GATEWAY_API_KEY`.
- **Runtime dependencies:** `ai` (the Vercel AI SDK, imported only by `src/gateway/vercel.ts`), `pngjs` and `jpeg-js` (pure-JavaScript image codecs). TypeScript stays on 6.0, the newest version typescript-eslint supports.

## Release-age exclusion for the `ai` SDK (assetforge#1, 2026-11-07)

`pnpm-workspace.yaml` lists `ai` and its three `@ai-sdk/*` packages, at exact versions, under `minimumReleaseAgeExclude`. pnpm 12's default release-age policy refuses versions published too recently; the dependency was pinned to the newest `ai` release on the day of implementation (`ai@7.0.165`, published 2026-11-07), so the gateway adapter was written and checked against the current SDK, and that release and its matching `@ai-sdk/*` packages were still inside the window. The exclusion names exact versions only, so any other version, including a later update, still waits out the window. Remove the file once those versions are older than the window (any day after 2026-11-08) and run `pnpm install` to confirm the lockfile is unchanged.

## Animation (owner, 2026-11-07)

Key pose first, then each frame a reference-guided edit of it. The key pose is approved by the author before any frame is edited: a sprite-strip spec must name it as `keyPose`, and Assetforge refuses a strip spec without one before any spend. The approved path is two runs: stage a `still` of the pose, choose one of the staged candidates (or any author-made image), then stage the strip with that file as `keyPose`. Video-to-frames comes later as another generator.

## Sheet generation first (owner, 2026-11-07; assetforge#10)

The model generates a whole animation cycle as one contact sheet, because a whole sheet keeps identity consistent; the import path cleans it up, and a per-frame reference edit is the fallback for fixing a single frame. Sheets made by other tools (the owner's Jimothy sheet came from ChatGPT image generation) take the same path. A vision model proposes the families, order and mirror pairs; the author confirms them by setting the grouping file's status to `confirmed`, which Assetforge never does itself. Registration pins the feet baseline and centre of mass to the anchor with one common scale, and refuses a family whose measured jitter exceeds the bound (1 px by default). Details in [sheet-import.md](sheet-import.md).

## Style profile (owner, 2026-11-07; assetforge#10)

Assetforge is not tied to one visual style. The target profile's optional `style` (alpha mode, colour rule, edges, after clockgrove/clockgrove#61) decides post-processing: soft 8-bit alpha and full colour for a painterly world, binary alpha, crisp edges or a palette for flat-cartoon and pixel-art worlds. Without one, the sheet import uses soft alpha and full colour. The first loop's `stage` and `pick` still post-process to binary alpha and the bible palette; moving them onto the style profile is separate work.

## Picking (owner, 2026-11-07)

The operator picks. `assetforge stage` stages only QA-passing candidates with their reasons; `assetforge pick` writes the chosen one with the review field at the profile's pending value. Assetforge never writes any other review value.

## License of generated output (Kirk, 2026-11-07)

Assetforge writes the license value the target profile declares (Clockgrove: MIT) and records the models, route and provider terms in provenance.

## Provider output grants (assetforge#47, 2026-11-09)

Provider terms differ on who owns an output (Meshy free: CC BY 4.0 with credit; Tripo free: rights kept by Tripo, no commercial use; paid plans give ownership). Each route declares its `outputGrant` (`license`, `plan`, `commercial`, `relabel`, `attribution`; names shared with clockgrove/clockgrove#61), every call records it, and the provenance carries the combination over its calls, the most restrictive winning. The provenance's `license` is the target's licence only when the grant allows relabelling; otherwise the granted licence, when it is commercial and the target lists it in `acceptedLicenses`. Anything else is refused at hand-off (`pick`, `write-families`) with exit 7 (`license_refused`) before a file is written. Staging is unaffected, so free-credit spikes that never reach a target still run.

## Packaging (assetforge#21, 2026-11-07)

Owner decision: publish as `@clockgrove/assetforge`. The unscoped name `assetforge` is taken.

- The package ships compiled JavaScript in `dist/`, because Node refuses to strip types inside `node_modules`. `tsc -p tsconfig.build.json` builds it, with `rewriteRelativeImportExtensions` turning `.ts` imports into `.js`.
- The repository still runs the sources directly. Development has no build step.
- The package ships `dist/`, `skills/`, the README and the LICENSE.
- The version stays `0.0.0` in the repository. The release sets it from the exact tag.
- Publishing is left to a maintainer: the npm org, trusted publishing and the release workflow under `.github/`.

## CLI contract (assetforge#21, 2026-11-07)

- With `--json`, stdout is one JSON document: `ok`, `exitCode`, `command` and, on refusal, `error` with `code` and `message`. Logs go to stderr. Nothing prompts.
- Exit codes: 0 success, 1 unexpected internal error, 2 invalid input, 3 cap refused (also a dry-run forecast over the cap), 4 provider error, 5 QA found nothing, 6 the target's validator rejected what was written (`pick` or `write-families`).
- `--dry-run` (on `stage` and `generate-sheet`, the commands that generate) spends nothing and needs no key.
- `--provider-script` runs a scripted provider for offline runs.
- Every future command follows this contract.

## Media transformation core (assetforge#23, 2026-11-07)

- Operations are declared once, by name and parameter schema, in `src/transform/operations.ts`. Engines implement them behind the `ImageEngine` adapter. The in-house engine is `assetforge-raster` 1.0.0, and its version is bumped whenever an operation's output bytes change.
- Recipes are JSON (`format: "assetforge-recipe/1"`). YAML was left out because it would need a parser dependency. The parameter schemas use a small JSON Schema subset kept in the repository, with no new dependency.
- Provenance steps are chained by pixel hashes, so intermediate images are never encoded. Sources and written files also record their file SHA-256. The record holds no time, so reruns are byte-identical.
- WebP output is lossless VP8L from an in-house encoder, which is deterministic and needs no native dependency. KTX2 waits for the material maps (#14).
- The sheet import runs on these operations, with byte-identical output.

## Generation constitutions (owner, 2026-11-08; assetforge#28)

Art direction lives in a target-owned Markdown bible with validated YAML front matter, prose rationale and Do's and Don'ts. The `yaml` parser is pinned to 2.9.1 because this format requires YAML; existing JSON profile, spec and recipe formats remain unchanged. Palette, outline, lighting, fog, saturation and value bounds use DTCG 2025.10 typed tokens. Art-specific axes remain in the art schema.

The target-owned Agent Skill links the bible and starting presets. DESIGN.md contributes UI colour context only; Assetforge does not extend its format with art direction. Prompt templates are copied into the target repository on explicit initialization and versioned there. `plan` records compilation and model inputs; `apply` checks their hashes and authorizes generation spend without approving an asset.

## Identity lock v1 (assetforge#39, 2026-11-08)

Every candidate of a character with an identity lock is scored against its identity record by a typed decision model (a five-level Score question) through the gateway's `identity` route, default `perplexity/pplx-decider-v1.2` from #27's image eval, with `openai/gpt-6-luna-decisions` as the alternate. Scoring starts in **shadow mode**: it runs beside the current QA, records the score and the agreement with QA, and filters nothing. Filtering (`identity.mode: "enforce"`) is opt-in per target profile until shadow runs have measured agreement. Scoring never approves.

**Threshold: 0.68 (owner, 2026-11-08).** The default comes from `assetforge identity-eval` run by the owner on #27's identity set, which stays local: 22 labelled crops, each judged against both locks (Stevie's approved three-quarter turnaround; Jimothy's sheet cell 3 plus his painted portrait), so 44 cases, 19 of them "same".

| Model                                  | Recommended threshold | Accuracy    | False accepts | False rejects | Cost (44 calls) | p50 latency |
| -------------------------------------- | --------------------- | ----------- | ------------- | ------------- | --------------- | ----------- |
| perplexity/pplx-decider-v1.2 (default) | 0.678                 | 40/44 (91%) | 0             | 4             | $0.0014         | 1.15 s      |
| openai/gpt-6-luna-decisions            | 0.395                 | 38/44 (86%) | 1             | 5             | $0.0084         | 1.12 s      |

pplx-decider-v1.2's sweep:

| Threshold                               | False accepts | False rejects |
| --------------------------------------- | ------------- | ------------- |
| 0.60                                    | 11            | 0             |
| 0.625 (the earlier provisional default) | 9             | 1             |
| 0.65                                    | 6             | 3             |
| 0.678                                   | 0             | 4             |

Same-character scores bunch at 0.61–0.65, so lower thresholds let many wrong-character crops through; at 0.68 none pass. The 4 false rejects are Stevie's back view, two Stevie meshes from the 3D spike and one Jimothy cell; enforce mode shows the person each with its score. pplx-decider-v1.2 stays the default model: more accurate and about 6× cheaper than the alternate.

**Shadow mode stays the default.** The set is small, and 4 of 19 same-character cases would be filtered. The set has no per-case verdicts from today's vision QA, so its agreement figure is label agreement (40/44), not QA agreement; shadow runs on real art measure QA agreement before enforce becomes the default.

#27 found decision-model confidence between 0.5 and 0.8 even on correct answers, so the threshold is applied to the score, not the confidence. Confidence is logged for later analysis.

## Decision models for QA (owner, 2026-11-08; assetforge#27)

#27 measured gateway decision models on image questions and closes with these outcomes:

- **Identity scoring uses a decision model.** #39 scores every candidate of a locked character with `perplexity/pplx-decider-v1.2`, in shadow mode, at the 0.68 threshold (see Identity lock v1 above).
- **Per-frame checks during a strip need no decision model.** A whole cycle is generated as one sheet (#10), and #38 checks it with pixel QA, one vision check for identity flicker and a budgeted per-frame fix.
- **No decision-model perspective check.** Perspective stays in the candidate's vision QA. That vision call costs about half a cent next to a candidate of about $0.25, authors rely on its written reason, and there is no labelled perspective data to choose a model or cutoff from.
- **Lit and style checks** cite #27's numbers when their Objectives are filed.

Moving identity flicker to a decision-model screen is filed only once more labelled flicker data exists.
