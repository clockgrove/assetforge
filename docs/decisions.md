# Decisions

## Language and tooling (assetforge#1, 2026-11-07)

Chosen so the first adopter, Clockgrove (Node 24, pnpm, TypeScript), runs Assetforge with no new runtime.

- **TypeScript on Node 24, no build step in development (the build is only for the package).** Node runs the `.ts` sources directly with its built-in type stripping, so the code uses erasable syntax only (no enums, namespaces or parameter properties) and imports name their `.ts` files. `tsc --noEmit` checks the types.
- **pnpm**, pinned through `packageManager` and enabled with corepack. CI installs with `pnpm install --frozen-lockfile --ignore-scripts`; no dependency needs an install script.
- **Commands:** `pnpm check` runs Prettier, ESLint (typescript-eslint) and `tsc --noEmit`. `pnpm test` runs `node:test` over `test/**/*.test.ts`, offline with the scripted provider. `pnpm test:real` runs the opt-in real-provider checks in `test/real/`, which skip without `AI_GATEWAY_API_KEY`.
- **Runtime dependencies:** `ai` (the Vercel AI SDK, imported only by `src/gateway/vercel.ts`), `pngjs` and `jpeg-js` (pure-JavaScript image codecs). TypeScript stays on 6.0, the newest version typescript-eslint supports.

## Release-age exclusion for the `ai` SDK (assetforge#1, 2026-11-07)

`pnpm-workspace.yaml` lists `ai` and its three `@ai-sdk/*` packages, at exact versions, under `minimumReleaseAgeExclude`. pnpm 12's default release-age policy refuses versions published too recently; the dependency was pinned to the newest `ai` release on the day of implementation (`ai@7.0.165`, published 2026-11-07), so the gateway adapter was written and checked against the current SDK, and that release and its matching `@ai-sdk/*` packages were still inside the window. The exclusion names exact versions only, so any other version, including a later update, still waits out the window. Remove the file once those versions are older than the window (any day after 2026-11-08) and run `pnpm install` to confirm the lockfile is unchanged.

## Characters are real-time 3D (Kirk, 2026-11-10)

Raccoon World's characters are rigged models in Clockgrove's live renderer, with an animation clip per family. Not 3D rendered to sprites, and not 2D sprites. Zoom, lighting and camera come from the renderer, and a new animation is a clip on the same rig rather than new art. Assetforge's waves 0 and 1 moved to 3D characters. The 2D path (sheet generation and import, transformation core, loop QA, identity lock v1) stays for props, terrain, effects, UI and targets that use sprites. The first 2D shelter run (clockgrove/raccoon-world PR #21) is kept as the record of the 2D try. A 3D asset ships only under an output grant the target accepts (assetforge#47): Meshy's free-plan CC BY 4.0 output is accepted by Raccoon World with its credit line, while non-commercial or provider-retained output is refused.

Wave 0 proves the loop with a walk clip: Tripo's clip library has no quadruped idle, so `idle` is reported missing rather than faked. A custom quadruped idle is the first item of wave 1 (Kirk, 2026-11-10). Animation is the provider's auto-rig plus its clip library, retargeted per family; custom clips only where the library has nothing close (Kirk, 2026-11-10).

## Shared rig and generated gait (Kirk, 2026-11-10)

Characters of one kind share a skeleton template fitted to each model, and their locomotion is generated from a gait profile the target declares, with foot-contact, joint-limit and skinning QA (assetforge#84). This replaces the provider's auto-rig plus clip library for any kind whose target declares a template. The trigger was Kirk's read of wave 0's picked Stevie (c3): Tripo's library walk is dog-like, with raised hind ankles, front wrists that fold and pinched ankles. Real raccoon kits, in his porch footage (clockgrove/raccoon-world `references/stevie/gait-reference/`, frames only, never the clip), walk plantigrade, with flat hand-like front paws, a hunched back and a low swaying tail.

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
- Exit codes: 0 success, 1 unexpected internal error, 2 invalid input, 3 cap refused: the run's cap or a cross-run spend limit (also a dry-run forecast over either; assetforge#74), 4 provider error, 5 QA found nothing, 6 the target's validator rejected what was written (`pick` or `write-families`), 7 licence refused: the provider's output grant does not let the target declare the output (`license_refused`, nothing written; assetforge#47).
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

## Identity locks cannot tell look-alike characters apart yet (2026-11-11)

The identity route stays `perplexity/pplx-decider-v1.2` at 0.68, in shadow mode. **Enforce mode must not be used for a cast of look-alike characters.** A wider eval found that the lock-score route can tell a character's kind from something else, but not one look-alike cast member from another. Raccoon World was the fixture: 44 images of Stevie (2D strips, turntable views, 3D renders, photos) against 67 images of other raccoons in the cast (44 Jimothy, 16 Gracie including all three turnaround candidates, plus kits and Peanut), every one scored against Stevie's lock:

| Model                        | ROC AUC | False accepts at 0.74 | False rejects at 0.74 |
| ---------------------------- | ------- | --------------------- | --------------------- |
| perplexity/pplx-decider-v1.2 | 0.55    | 0 of 67               | 34 of 44              |
| google/gemini-decision-1     | 0.49    | 26 of 67              | 21 of 44              |

An AUC of 0.5 is chance. The features the cast shares satisfy every level of the Score question for any of its members. A one-day switch to gemini-decision-1 (#90), based on a 20-case 3D set with only Gracie's c1 turnaround as the negative, was reverted when Gracie's c2 and c3 views scored up to 0.83 and Jimothy up to 0.87. Its evidence was a small-sample artefact. pplx stays the default because both models are equally blind and pplx costs a tenth as much. Keeping characters on-model is assetforge#92. It is cast-agnostic, and is measured on drift of the same character, generic members of the type and look-alike cast members, for more than one cast. Enforce mode waits for its measured bar.

A follow-up the same day found a second cause: the record contradicted its references. Stevie's v1 record called him lean, upright and long-legged, but his approved turnaround is stocky and short-legged. Models that trusted the text rejected the real Stevie and accepted the lean Gracie. Raccoon World corrected the record in clockgrove/raccoon-world#65 (lock v2). A rerun on v2 showed the text was not why the lock fails. Recall of the real Stevie recovered, but the single-reference lock stayed at chance (AUC 0.49–0.55), and Gracie was still taken for Stevie. One reference cannot separate look-alikes, so the table above stands. Vision chat models (Claude Opus 5.5, GPT-6.1 Terra, Gemini 4 Argon) did no better on the same question (lock AUC 0.33–0.58). Choosing among the whole cast's references did better: 90.2% for GPT-6.1 Terra on lock v2, with a generic "any other character is neither" sentence. It still passed about half the other raccoons, so shadow mode stays. #92 now also requires catching a record whose text disagrees with its references.

## Identity lock bar: measured on two casts, not met yet (2026-11-11; assetforge#92)

**The bar for enforce mode** is ROC AUC ≥ 0.95, false accepts ≤ 5% and false rejects ≤ 10%. Every negative kind (drift, generic, look-alike) and every cast must meet it on 2D cases of trusted records (records that pass their record check), at a threshold fixed before the run. It is `IDENTITY_ENFORCE_BAR`, and `identity-eval` reports it. 3D results are provisional: no threshold or bar rests on them until look-dev (#82) renders in the bible's style.

**No question meets the bar yet, so shadow mode stays the default.** The default question stays `score` (`perplexity/pplx-decider-v1.2`) at 0.68. `identity.question: "cast"` stays opt-in, at 0.5 when used, for shadow runs.

**The set** is `node test/fixtures/identity-set/build.ts`: 184 cases, all from public or synthetic sources.

- **Raccoon World** (clockgrove/raccoon-world at e9079d8, lock v2): 30 same (Stevie's turnaround views and window photo, 14 frames of his owner-picked comparison strips, 12 cells of Jimothy's contact sheet without his lock cell), 21 drift, 20 generic and 34 look-alike.
  - Drift: 9 pixel edits of approved references, and 12 model edits checked by eye (no tail rings, no mask, pointed ears, long legs, orange or silver coat, stub tail, dark muzzle, spots, a lean Jimothy). 6 flux-kontext edits that did not change the image were dropped and remade on gpt-image-2.
  - Generic: 8 on-style generated raccoons and 2 photos of unknown raccoons, each judged against both locks.
  - Look-alike: Gracie's photos and each locked character's art judged against the other's lock.
  - Also 18 3D cases (Stevie's wave-0 renders and two drift edits).
- **Pebble birds**, synthetic, drawn in code: three look-alike birds, with 18 same, 12 drift, 9 generic and 12 look-alike cases.
- **Two conflicted records:** Stevie's v1 lean text against v2's references, and a bird whose text was swapped, with 10 cases.

**The record check** caught both deliberate conflicts and passed Jimothy and the accurate birds. It also flags **Stevie's lock v2**: "five dark rings" and "back carried level" disagree with his approved three-quarter view, which shows about three rings and a rounded back. So every case judged against Stevie's lock is untrusted: kept out of the bar and never used for filtering. That is a finding for clockgrove/raccoon-world, not tuned away here. It also means the trusted Raccoon World positives are Jimothy's 12 sheet cells alone.

**Numbers** (2D, trusted records, 99 cases; one run per question; GPT-6.1 Terra for `cast`):

| Question, threshold             | AUC   | Drift AUC | Generic AUC | Look-alike AUC | False accepts | False rejects | Birds FA / FR | Raccoon World FA / FR |
| ------------------------------- | ----- | --------- | ----------- | -------------- | ------------- | ------------- | ------------- | --------------------- |
| `score` (pplx), 0.68            | 0.972 | 0.898     | 1.000       | 1.000          | 22% (15/69)   | 3% (1/30)     | 33% / 0%      | 11% / 8%              |
| `cast`, who only, 0.5           | 0.931 | 0.750     | 1.000       | 1.000          | 23% (16/69)   | 0%            | 36% / 0%      | 11% / 0%              |
| `cast` with on-model check, 0.5 | 1.000 | 1.000     | 1.000       | 1.000          | 0% (0/69)     | 7% (2/30)     | 0% / 0%       | 0% / 17% (2/12)       |

**Per kind and per cast** (same run; the trusted 2D negatives are 19 drift, 19 generic and 31 look-alike; a kind's false rejects are the 30 positives, so they equal the overall figure):

| Question, threshold             | Drift FA    | Generic FA | Look-alike FA | Birds AUC | Raccoon World AUC |
| ------------------------------- | ----------- | ---------- | ------------- | --------- | ----------------- |
| `score` (pplx), 0.68            | 79% (15/19) | 0% (0/19)  | 0% (0/31)     | not kept  | not kept          |
| `cast`, who only, 0.5           | not kept    | not kept   | not kept      | not kept  | not kept          |
| `cast` with on-model check, 0.5 | 0% (0/19)   | 0% (0/19)  | 0% (0/31)     | 1.000     | 1.000             |

The per-case logs of these runs were not kept, so only the cells that follow from the recorded figures are filled. All 15 of `score`'s false accepts are drift: generic and look-alike AUC is 1.000, so every such negative scores below every positive, including the one positive under 0.68. With overall AUC 1.000, every subset of the on-model run, so each cast, is also 1.000. "Not kept" cells need the rerun that enforce waits for anyway (below), where `identity-eval` reports them per kind and per cast.

- **Choosing among the cast tells look-alikes and generics apart.** Every question reaches AUC 1.000 on those kinds with trusted records, where the single-reference lock was at chance (above).
- **Drift was the gap.** "Who is this" answers "Stevie" for an orange or ringless Stevie (0.96–0.98). So the cast call now also asks whether the candidate is on-model for the subject against its references, and the score is p(subject) × p(on-model). That closes drift on trusted records.
- **It misses the bar on one count:** Raccoon World's false rejects at 0.5 are 2 of 12 Jimothy cells (0.29 each, for a pale forehead stripe and a narrower muzzle). The sweep's 0.29 has no errors, but it was picked on the same set.
- **It is strict across views of a one-reference lock.** Counting Stevie's untrusted record as if trusted, his side and back turnaround views score 0.29–0.35 ("one more tail band"), and all 14 comparison-strip frames score 0.01–0.13 (narrower face, domed back, weaker streaking). Those 14 frames are generated, so each carries an eye check against his turnaround in the fixture: all show his mask, ears, coat, stocky short-legged body and banded tail; the domed back and softer streaking are rendering variation, so they stay labelled same. False rejects for Raccoon World are then 50% (15/30).
- **3D (provisional, 18 cases):** AUC 0.41–0.72; every Stevie render is rejected at any of these thresholds.
- **Cost:** the measured runs cost $1.92 (pplx $0.02; Terra $0.83 and $1.06 with the on-model check, about $0.006 a case). The generated images cost $0.75.
- **Prompt wording:** the shipped on-model sentence is the one the run used: "the approved references are the source of truth".

**Rerun on Stevie's lock v3 (2026-11-11, 7:39 PM PST; thresholds fixed before the run).** Raccoon World's lock v3 (clockgrove/raccoon-world#72, commit 5070a0b) fixed the record: it now passes its check and lists the front, side and back views as references. The fixture now pins that commit. The thresholds were fixed beforehand at the shipped defaults: `cast` at 0.5 and `score` at 0.68. On 2D, trusted records, there were 156 cases (48 positives):

| Question, threshold  | AUC   | Drift AUC | Generic AUC | Look-alike AUC | False accepts | False rejects | Birds FA / FR | Raccoon World FA / FR | Spend |
| -------------------- | ----- | --------- | ----------- | -------------- | ------------- | ------------- | ------------- | --------------------- | ----- |
| `cast` (Terra), 0.5  | 0.982 | 0.975     | 0.977       | 0.991          | 0% (0/108)    | 33% (16/48)   | 0% / 0%       | 0% / 53% (16/30)      | $1.26 |
| `score` (pplx), 0.68 | 0.865 | 0.676     | 0.976       | 0.930          | 21% (23/108)  | 33% (16/48)   | 36% / 0%      | 15% / 53%             | $0.01 |

**The bar is not met, and only on false rejects.** `cast` accepted no wrong character, generic or drift edit. Its 16 false rejects are all Raccoon World:

- 13 of the 14 frames of Stevie's comparison strips, and 2 of Jimothy's sheet cells. The model named the right character every time (confidence 0.95–0.99), but its on-model check scored rendering variation as drift: shorter tail, fewer distinct bands, orange flecks on the brows, smaller eyes, a domed back.
- The photo of Stevie at the window, called "none of the cast": a real photo against illustrated references.

The sweep's best threshold, 0.0245, would give 3% false accepts and 2% false rejects, but it was picked on this set and is not a result. **Shadow mode stays the default, and `question: "cast"` is not switched on for Raccoon World yet.** 3D (provisional, 18 cases) rejects every Stevie render (AUC 0.61).

**What is open:**

- **The on-model check is too strict on generated frames.** It needs to tell rendering and pose variation from identity drift, measured on a held-out set at a threshold fixed beforehand.
- **Some comparison-strip frames may really be off-model**, for example orange flecks and a shorter tail. Whether they count as on-model is a labelling call for the person who approves the art. Their "same" labels stay until that is decided.
- **The 3D numbers wait for #82.**

## Decision models for QA (owner, 2026-11-08; assetforge#27)

#27 measured gateway decision models on image questions and closes with these outcomes:

- **Identity scoring uses a decision model.** #39 scores every candidate of a locked character with `perplexity/pplx-decider-v1.2`, in shadow mode, at the 0.68 threshold (see Identity lock v1 above).
- **Per-frame checks during a strip need no decision model.** A whole cycle is generated as one sheet (#10), and #38 checks it with pixel QA, one vision check for identity flicker and a budgeted per-frame fix.
- **No decision-model perspective check.** Perspective stays in the candidate's vision QA. That vision call costs about half a cent next to a candidate of about $0.25, authors rely on its written reason, and there is no labelled perspective data to choose a model or cutoff from.
- **Lit and style checks** cite #27's numbers when their Objectives are filed.

Moving identity flicker to a decision-model screen is filed only once more labelled flicker data exists.
