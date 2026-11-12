# Generation knobs

`plan` compiles a reviewable file; `apply` spends against that exact file. Neither command asks a terminal question. Plan approval authorizes generation spend; generated assets remain pending human review.

## Start a world

Run in the target repository:

```sh
assetforge bible init --directory . --world "Example World" --preset cozy-storybook --json
assetforge bible describe --bible .assetforge/art-direction/BIBLE.md --json
```

Available presets are `cozy-storybook` (soft painterly storybook), `flat-cartoon-kids` (bold outlines and simple flat shading), and `dark-gritty-isometric` (restrained colour, worn surfaces and an isometric camera). They use plain visual descriptions, never named games, studios or artists.

Initialization writes `.assetforge/art-direction/BIBLE.md`, its adjacent `SKILL.md`, repository-owned copies under `presets/`, and `.assetforge/prompts/default.md`. Commit these files with your target repository. The skill links the bible, anchors and presets so a harness can load them while generating or reviewing art. Existing JSON bibles remain supported by the older generation commands; new plan/apply uses the Markdown bible.

To switch the look of later plans without a code change:

```sh
assetforge bible preset --bible .assetforge/art-direction/BIBLE.md --preset flat-cartoon-kids --json
```

This loads the preset from the target repository's sibling `presets/<preset>.md`. It changes look, tone and their token bounds while retaining the world's name, palette, anchors, identity locks and prose. Review the changed bible and commit it; plans made before the switch become stale. Edit the repository's preset files to customize future switches.

## Four layers

The bible is the constitution. Its YAML front matter declares `version`, `world`, `preset`, `axes`, `tone`, `anchors`, `colorRule`, `tokens`, `adjustable` and `identities`. Markdown after the front matter preserves prose rationale and unknown sections. The Do's and Don'ts section describes how positive and negative image anchors should be interpreted.

`axes` contains rendering (`painterly`, `naturalistic`, `flat-cartoon`, `pixel` or `stylised-3d`), realism, proportions, outline weight and colour, shading, detail density, texture and the lighting key. Saturation bounds and outline colour are DTCG tokens; the outline axis references its colour token. `tone` declares audience, allowed moods and content limits. `anchors.positive` and `anchors.negative` contain image paths, roles and optional subjects. References resolve relative to the bible.

`looks` (optional) maps a look name, such as `character` or `environment`, to the axes it overrides. A spec whose `look` names it is planned with those axes, and with the anchors that carry that `look` or none. Other specs ignore it. A look may override any axis, `rendering` included, so a world can pair characters of one rendering with an environment of another.

Machine-readable colours, lighting, fog, value ranges and optional timing use [DTCG 2025.10 typed tokens](https://www.designtokens.org/tr/2025.10/format/), with `$type` and `$value`. The shipped bible provides the valid starting shape, including DTCG colour objects. For example:

```yaml
tokens:
  palette:
    ink:
      $type: color
      $value:
        colorSpace: srgb
        components: [0.1, 0.1, 0.15]
  valueRange:
    min: { $type: number, $value: 0.1 }
    max: { $type: number, $value: 0.9 }
```

For a character, add an `identities` entry keyed by the asset's `subject` (which defaults to `assetId`):

```yaml
identities:
  example-character:
    version: "1"
    approved: true
    turnaround: anchors/example-turnaround.png
    signatureFeatures: [round ears, striped tail]
    proportions: short legs and a broad head
    palette: ["#29303b", "#d2b48c"]
```

Every plan for that character attaches the approved turnaround and the lock automatically. Add approved images in your own repository; Assetforge ships no private character art.

The asset spec still describes the requested asset. A separate brief supplies its purpose and context:

```json
{
  "purpose": "portrait icon",
  "appearsIn": "night scene after a storm",
  "neighbouringAssets": ["den", "wet lantern"],
  "mood": "mildly eerie",
  "context": "the character is waiting for the rain to stop"
}
```

An optional `adjustments` object can request only fields listed in the bible's `adjustable` bounds. A brief cannot rewrite the audience, palette, identity, rendering or content limits. Out-of-range moods or permitted adjustments are clamped and recorded; unsupported constitutional overrides and named-style imitation are refused. LLM output is checked too. Named-style phrases and recognized game, studio and artist names are refused case-insensitively across brief, spec and compiler prose. Ordinary free-text context is accepted without a fixed vocabulary. Profile palettes must be compatible with the bible; a palette rule in either layer constrains both prompts and postprocessing.

For UI-facing purposes such as icons, portraits and badges, a target repository's `DESIGN.md` `colors` (from front matter or fenced YAML) contributes subordinate interface palette context. The art bible remains authoritative; Assetforge does not extend DESIGN.md with art direction.

Run settings are a separate JSON file:

```json
{ "candidates": 2, "capUsd": 2, "strictness": 0.8, "exploration": 0.1 }
```

`strictness` is the minimum style score (0–1) for showing a candidate. `exploration` ranges from exactness (`0`) to exploration within the constitution (`1`). Optional `seed` requires a route that supports seeds. `modelRoute`, `llmRoute` and `qaRoute` can override their respective route objects. Each route declares `model`, `estimatedCostUsd`, `providerTerms`, and optional `outputGrant`, `size`, `supportsSeed` and `providerOptions`. `outputGrant` is what the provider grants for the route's outputs: `license` (an SPDX ID, or `LicenseRef-<provider>-<plan>`), `plan`, `commercial`, `relabel` and, when credit is required, `attribution`; for example Meshy's free plan is `{ "license": "CC-BY-4.0", "plan": "free", "commercial": true, "relabel": false, "attribution": "Model by Meshy" }`. The default routes are paid API routes that give ownership (`relabel: true`). A route override merges over its default, so when it changes the provider it must set `providerTerms` and `outputGrant` too; a route without a grant is taken as relabellable. Alternatively, `--routes routes.json` accepts the existing route format: `still` for generation, `compiler` for prompt compilation and `vision` for style QA. Every provider call reserves estimated spend against the cap before running.

## Plan, inspect and apply

```sh
assetforge plan --spec spec.json --bible .assetforge/art-direction/BIBLE.md \
  --profile profile.json --brief brief.json --settings settings.json --out plan.json --json
assetforge apply plan.json --auto-approve --out .assetforge/runs --json
```

`plan` never generates images. It calls the configured compiler LLM to produce final positive and negative prompts for the target model family. It records the exact compiler output, route, template version and hash, references with roles and hashes, clamps, candidate count, settings, cost forecast and constitutional directives. If the compiler is unavailable, a deterministic template-only fallback is recorded as `template-fallback`; malformed or unsafe model output is refused.

The repository's default template supports `{{constitution}}`, `{{spec}}`, `{{brief}}`, `{{settings}}` and `{{family}}`. Override it in git or select another repository file with `--template`. Presentation, background and lighting belong in that template and bible. There is no global painterly presentation instruction.

A human can review a plan and set only its `approved` field to `true`, then run `assetforge apply plan.json`. An unattended campaign explicitly passes `--auto-approve`. Any other plan edit requires planning again. Apply reloads and hashes the bible, template, character identity and image references before any generation. Changed source files invalidate the plan even when their declared versions were not bumped. Applied candidates carry the plan's exact compiler inputs and output in provenance and remain pending asset review.

Model credentials come from `AI_GATEWAY_API_KEY`. Tests and offline harnesses can pass `--provider-script module.mjs`, whose default export supplies the existing `{ image, vision }` scripted provider contract, plus `decide` for identity scoring (it returns `{ answer: { type: "score", score } }` or `{ answer: { type: "boolean", probability } }`). The compiler uses `vision` with its compilation request; return JSON containing `prompt`, `negativePrompt`, `violations` and `clamps`. For sprite strips, the compiler also returns `framePrompts`, one entry per frame of the approved key pose. Candidate QA returns JSON containing `styleScore`, `passed` and `reason`. Real providers are opt-in.

## Identity lock scoring

A character with an identity lock in the bible (`identities.<subject>`) has an identity record: the approved turnaround, any further approved `references` (paths relative to the bible), and the fingerprint a model checks for: `signatureFeatures`, `proportions` and `palette`. The record is versioned with the lock. Bump the lock's `version` when you change it; every score names the lock version and the hash of the whole lock, so an edit is visible even without a bump.

Every candidate of a locked character is scored against its record by a typed decision model through the gateway (the `identity` route, default `perplexity/pplx-decider-v1.2`). The call is a Score question over five levels, from "a different character" to "the same character: every signature feature, the proportions and the colours match". The identity score is the answer's position over those levels, from 0 to 1. The reason shown is the matching level with the score, threshold, lock version and confidence. With `identity.question: "boolean"` the score is the model's probability that the candidate is the same character. Images under 384 px on a side are upscaled before the call, because some decision models reject small images. Every call logs its label, confidence, latency and cost on stderr and in its call record (`decision`).

With `identity.question: "cast"` the candidate is judged as a choice among the whole cast instead of a yes or no against one character. The cast is every identity record in the same bible, so nothing is tuned to one species or style. One vision call on the `identity-cast` route (default `openai/gpt-6.1-terra`) sees the candidate and each member's approved references and written signature. It is told that any other character, including one of the same species or kind, is "neither". The same call also asks whether the candidate is on-model for the subject: its markings, colours, proportions and signature features against the subject's approved references, which win where the written record disagrees. The model answers with a probability for each member and for "neither", its choice, `onModel` (the probability that nothing is missing, added or changed), the deviations it found and one sentence of reason. The identity score is the subject's probability, normalised over those options (1 or 0 when the model gives only a choice), times `onModel` (1 when the answer leaves it out). So a recognisable but drifted character, such as the right raccoon with an orange coat, scores low. An off-model reason names who the model saw instead, or "none of the cast", with its sentence, or, for the subject, "off-model" with the deviations. An answer that cannot be read is a failed score. One call sends at most 16 images (`IDENTITY_CAST_MAX_IMAGES`, the candidate included), so the route's estimate stays an upper bound for any cast: every member keeps its turnaround, further references are added one per member in turn with the subject first, and a bible with more than 15 identity records is refused. The cast question stays opt-in, and the default stays `score` at 0.68, while shadow runs measure it (decisions.md, "Identity lock bar"); 0.5 is the threshold measured for it.

The target profile configures it:

```json
{ "identity": { "mode": "shadow", "threshold": 0.68, "question": "score" } }
```

- `shadow` (the default) scores every candidate beside the current QA and filters nothing. The reason is marked `shadow`, and `run.json` counts how often the identity verdict agreed with QA (`identity.agreement`).
- `enforce` filters a candidate below the threshold, or one whose scoring call failed, as other QA failures are filtered. `run.json` lists each filtered candidate's reasons under `rejections`, and `apply` prints them.
- `off` skips scoring.

`plan --identity-mode <off|shadow|enforce>` overrides the profile for one plan. The plan records the mode, threshold and route, and its forecast includes one identity call per candidate. For imported sheets, `import` and `generate-sheet` take `--lock-bible <BIBLE.md>` (the art bible holding the locks) and `--identity-mode`. The contact sheet is scored at import. In enforce mode below the threshold, `write-families` refuses the sheet with the reason. Characters without a lock are never scored.

### A record that disagrees with its references

A record is trusted only when its written signature features, proportions and palette agree with its own approved references. The references are the source of truth: a record that calls a stocky character lean makes a model reject the real character and accept a lean look-alike. `checkIdentityRecord` asks a vision model on the `identity-check` route to compare each written claim with the reference images, and returns each conflict with the claim and what the references show.

- **At record time:** `assetforge identity-check --bible BIBLE.md [--subject <name>]... [--json]` checks every record (or the named ones), prints each verdict with its reason, and exits 1 when any record conflicts or could not be checked.
- **In enforce mode:** a run checks each record once before its first score. A record that conflicts is not used for filtering: its candidates are still scored, but in shadow mode, and the reason says why, until a person fixes the text or the references. A check that could not run (a provider error or an unreadable answer) fails closed like any provider failure in enforce mode: every candidate is filtered, with the reason. Shadow mode makes no check call. The plan records the check's route, so a `--routes` file applies to it.
- **In `identity-eval`:** every record the set uses is checked and the report lists each check. Cases scored against a record that conflicts or could not be checked are marked and reported as their own group: they are kept out of the sweep, the recommended threshold, the AUC, the per-kind and per-cast breakdown and the bar, since such a record never filters.

Scores land in each candidate's `fields.identity` and provenance (`provenance.identity`: score, label, confidence, threshold, mode, lock version and hash, model, request ID, latency and cost), so the spread of identity scores across an approved set can be read later. Scoring filters and explains. It never approves; the person still picks.

### Choosing the threshold

```sh
assetforge identity-eval --bible BIBLE.md --cases cases.json --profile profile.json \
  --log identity-eval.jsonl --json
```

`cases.json` is a local labelled set: `[{ "image": "a.png", "subject": "stevie", "same": true, "qa": true }, ...]`, with image paths relative to the file and `qa` the current QA's verdict when known. The command scores each case, writes one JSON line per case to `--log`, and reports accuracy for every threshold, the recommended threshold (best accuracy, the middle of any tie), accuracy at the configured threshold, and agreement with the QA verdicts. Keep the set and the log out of the repository; they may hold a game's private art.

A case can also say what kind of case it is, so one set can measure every form of off-model across several casts:

- `kind`: `same`, or the negative kind: `drift` (the same character with wrong markings, colours or proportions, or a missing signature feature), `generic` (on-style and the right kind, but nobody in particular) or `lookalike` (another member of the same cast). It defaults to `same` or a plain negative, from `same`.
- `cast`: the cast the case belongs to (default: the bible's `world`).
- `medium`: `2d` (the default) or `3d`.
- `bible`: the bible holding the case's identity records, relative to the cases file. With it, `--bible` is optional, and one set can span several games.

The report gives ROC AUC, and the false-accept and false-reject rates per kind, per cast and per medium, at the configured threshold and at the recommended one. The threshold is recommended on the 2D cases only; a set with no 2D case recommends none. 3D results are reported separately and marked provisional: no threshold rests on them until renders are in the bible's style, and the bar is not judged on them. The report also checks the enforce bar (`IDENTITY_ENFORCE_BAR`: AUC, false-accept and false-reject rates that every kind and every cast must meet on 2D) and lists what falls short. A group the set cannot measure (a cast with no positives or no negatives, a kind with no cases of its own) is listed as "not measured" and fails the bar. Shadow mode stays the default until the bar is met.

The repository's acceptance set has two casts. Raccoon World is downloaded from clockgrove/raccoon-world's public references at a pinned commit, with frames cut from strips and contact sheets and with drift made by editing the approved references in code (`test/fixtures/identity-set/raccoon-world.ts`). It also has on-style generic raccoons and model-edited drift, made once through the gateway, checked by eye and committed with their provenance (`test/fixtures/identity-set/generate.ts`, `generated.json`, `generated/`). The second cast is a synthetic look-alike cast of birds drawn in code (`test/fixtures/identity-set/birds.ts`). Each set includes a record whose text contradicts its references. `node test/fixtures/identity-set/build.ts <out-dir>` writes the whole set and its `cases.json`; decisions.md records its makeup and numbers.

## MCP

```sh
assetforge mcp --provider-script scripted-provider.mjs
```

The server implements [MCP 2025-11-25 stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), using newline-delimited JSON-RPC on stdin/stdout. It supports initialize, ping, tools/list and tools/call. Diagnostics never occupy stdout.

The tools `bible_describe`, `bible_init`, `bible_preset`, `plan` and `apply` call the same code as the CLI. Arguments use local paths: `bible_describe` takes `bible`; `bible_init` takes `directory`, `world`, `preset`; `bible_preset` takes `bible`, `preset`; `plan` takes `spec`, `bible`, `profile`, `out`, and optional `brief`, `settings`, `routes`, `template`, `identityMode`; `apply` takes `plan`, optional `out`, and boolean `autoApprove`. A harness shows the returned plan to its user before invoking apply. Tool execution failures are MCP tool errors, so the harness can inspect and explain them.
