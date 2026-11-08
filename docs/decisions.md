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

**Threshold: 0.625, provisional.** The issue requires the default to come from logged eval data. No labelled image set was available when this was implemented: #27's set is kept local by the owner, and the run had no gateway key. So 0.625 is the midpoint between the rubric levels "partly the same" (0.5) and "the same character with a minor deviation" (0.75). It is not measured. It filters nothing in the default shadow mode. Replace it with the threshold `assetforge identity-eval` recommends on #27's set (or an equivalent local labelled set). Record the set's size, the model, the recommended threshold and the agreement with QA here when you do. #27 found decision-model confidence between 0.5 and 0.8 even on correct answers, so the threshold is applied to the score, not the confidence. Confidence is logged for later analysis.
