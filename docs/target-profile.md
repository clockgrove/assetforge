# Inputs: asset spec, style bible and target profile

Assetforge reads three JSON files. All three are data owned by the game; none of them is code here. Relative paths in a file resolve against that file's directory.

## Asset spec

```json
{
  "kind": "sprite-strip",
  "assetId": "stevie",
  "animationFamily": "shelter",
  "frames": { "count": 6 },
  "anchor": { "x": 16, "y": 30 },
  "keyPose": "poses/stevie-shelter-key.png",
  "fields": { "semantic": { "role": "actor", "entity": "grove.stevie" } }
}
```

- `kind` selects the generator: `sprite-strip` (frame edits of an approved key pose), `still` (one image) or `character-3d` (a rigged, animated `.glb`; its fields `gait`, `clips` and `heightM` and the profile's `model3d` section are in [characters-3d.md](characters-3d.md), including `model3d.handoff`, the clip fields and side images a target's validator takes). A new kind is a new generator.
- `subject` names the bible subject; it defaults to `assetId`.
- `look` (optional) names one of the bible's `looks`, such as `character` or `environment`. The asset gets that look's notes and references on top of the shared ones. An unknown look is refused before any spend.
- `frames.width` and `frames.height` default to the profile's frame size; `frames.count` defaults to 1.
- `anchor` is the pivot in frame coordinates: the bottom centre of the subject is aligned to it. It defaults to the bottom centre of the frame.
- `keyPose` (required for `sprite-strip`) is the author-approved key pose image; every frame becomes a reference-guided edit of it. A strip spec without one is refused before any spend. To make one through Assetforge, stage a `still` spec of the pose (set `frames.width` and `frames.height` larger than the profile's frame size for a detailed reference), look at the staged candidates, and name the chosen file as `keyPose`.
- `fields` holds extra values the profile's manifest template reads as `{{spec.fields.*}}`.

## Style bible

```json
{
  "version": "2026-11-07",
  "palette": ["#26242c", "#5f6470", "#8d939e", "#c4c9d2"],
  "references": [
    { "path": "refs/stevie-sheet.png", "role": "character sheet", "subject": "stevie" },
    { "path": "refs/yard-perspective.png", "role": "perspective" }
  ],
  "perspective": "refs/yard-perspective.png",
  "perspectiveDescription": "isometric, three-quarter view from above",
  "subjects": { "stevie": { "description": "a grey adult raccoon with a dark mask" } },
  "mood": ["quiet", "mature", "storybook realism"],
  "notes": ["warm lantern light against cool dusk rain"]
}
```

`looks` (optional) gives each domain of a world its own style, for example characters in naturalistic fur within a lightly painted yard. Each look has its own `notes`. A reference with a `look` is sent only for specs of that look; one without is sent for every look. A spec with no `look` gets only the shared notes and untagged references. Assetforge assumes no look names or styles: the target defines both.

```json
"notes": ["warm lantern light against cool dusk rain"],
"looks": {
  "character": { "notes": ["naturalistic illustrated fur, no visible brushwork"] },
  "environment": { "notes": ["soft visible brushwork, never photo-accurate"] }
}
```

`perspectiveDescription` (optional) tells the vision QA pass what view the perspective sample shows; without it QA compares against the sample alone. The subject's references, the perspective sample and a swatch of the palette are sent to the model as image references; the prompt is composed from these fields and the spec, never typed freehand. Post-processing snaps every colour to the palette, and QA compares the candidate with the references.

## Target profile

```json
{
  "name": "clockgrove",
  "license": "MIT",
  "acceptedLicenses": ["CC-BY-4.0"],
  "style": { "alpha": { "mode": "soft" }, "color": { "rule": "full" } },
  "values": { "creator": "Clockgrove" },
  "frames": { "width": 64, "height": 64, "maxEdge": 256, "durationMs": 250 },
  "layout": {
    "media": "assets/source/{{spec.assetId}}/{{spec.animationFamily}}.{{output.extension}}",
    "manifest": "assets/manifests/{{spec.assetId}}/{{spec.animationFamily}}.json"
  },
  "manifest": {
    "assetManifestVersion": 1,
    "assetId": "{{spec.assetId}}",
    "animationFamily": "{{spec.animationFamily}}",
    "source": {
      "kind": "generated",
      "path": "{{output.path}}",
      "creator": "{{profile.creator}}",
      "tool": "assetforge"
    },
    "license": "{{profile.license}}",
    "provenance": {
      "prompt": "{{provenance.prompt}}",
      "references": "{{provenance.referenceHashes}}"
    },
    "review": { "status": "pending" },
    "semantic": "{{spec.fields.semantic?}}",
    "frames": "{{output.frames}}",
    "anchor": "{{output.anchor}}",
    "bounds": "{{output.bounds}}",
    "palette": "{{output.palette?}}",
    "contentHash": "{{output.sha256}}"
  },
  "review": { "path": "review.status", "pending": "pending" },
  "validator": {
    "command": ["pnpm", "--filter", "@clockgrove/assets", "run", "validate", "{{manifest}}"]
  }
}
```

An optional `identity` object configures identity lock scoring: `mode` (`shadow`, the default, scores without filtering; `enforce` filters candidates below the threshold; `off`), `threshold` (0 to 1, default 0.68, chosen from eval data; see [decisions.md](decisions.md)) and `question` (`score`, `boolean`, or `cast`, which judges a candidate as a choice among every identity record in its bible and whether it is on-model for its subject). See [generation-knobs.md](generation-knobs.md#identity-lock-scoring).

This example follows the public manifest shape in Clockgrove's `packages/assets/docs/pipeline.md`; The paths are illustrative. Raccoon World's real profile and layout live in clockgrove/raccoon-world (raccoon-world#2); Clockgrove's validator support for external worlds is clockgrove/clockgrove#61.

- **Style.** `style` is the world's style profile: alpha mode (`soft` or `binary`, with a `threshold`), colour rule (`full` or `palette`) and edges (`antialiased` or `crisp`). The sheet import path follows it ([sheet-import.md](sheet-import.md#style-profile)). It is optional, and templates can read it as `{{profile.style}}`.
- **Templates.** `"{{a.b}}"` as a whole string inserts the value of any JSON type; `"{{a.b?}}"` drops the key when the value is undefined; `{{a.b}}` inside a longer string interpolates text. An undefined required value is an error.
- **Values available:** `spec.*` (the spec, with its `fields` also merged in), `profile.*` (`values`, `name`, `license`), `bible.version`, `output.*` (`path`, `mediaType`, `extension`, `sha256`, and what the generator adds: `frames`, `anchor`, `bounds`, `palette` for images; imported strips add `jitterPx` and set `palette` only under a palette colour rule), `provenance` (the full record) and `run.*` (`runId`, `candidateId`, `pickedAt`).
- **Licences.** `license` is the target's own licence, declared for outputs whose provider grant lets the target relabel them (paid plans that give ownership). `acceptedLicenses` (optional, default none) lists licences the target takes on purpose beyond its own, such as `CC-BY-4.0` when it publishes the credit line (`{{provenance.outputGrant.attribution}}`). Hand-off (`pick`, `write-families`) re-derives the output grant from the provenance's calls and refuses, before writing anything, with exit 7 (`license_refused`) an output whose grant neither allows relabelling nor is listed, and every non-commercial grant. In hand-off templates `{{profile.license}}` and `{{provenance.license}}` are the licence the output is declared under, so a template never relabels.
- **Provenance.** Every pick carries its full provenance record into the target. `layout.provenance`, when set, writes it as its own file at that path; the template can also embed `"{{provenance}}"`; with neither, it is written beside the media file as `<media path>.provenance.json`. The record holds the models, route, prompt, parameters, reference hashes, seed where supported, request IDs, times, cost, provider terms, bible version and license, the combined `outputGrant` (`license`, `plan`, `commercial`, `relabel`, `attribution`; the most restrictive grant over all calls wins), plus every call with its own `outputGrant`. Each call marks `costSource` (`provider` or `estimate`) and `requestIdSource` (`provider`, or `local` when the gateway reported no ID and Assetforge generated one).
- **Review.** Assetforge always sets the field at `review.path` to `review.pending` and never writes another value there.
- **Validator.** Run in the target directory after the pick is written, with `{{manifest}}` and `{{media}}` replaced by the written paths. A non-zero exit is reported as a rejection.
- **Media.** Each output declares its own media type and extension; `.gitattributes` in the target decides what Git LFS stores.
- **Spend.** An optional `spend` object, `{ "dailyLimitUsd": 10, "workItemLimitUsd": 5 }`, sets the cross-run spend limits below. Each is a non-negative USD amount.

## Spend limits across runs

A run's `--cap` bounds that run alone. A spend ledger bounds what all runs spend together (assetforge#74): every paid call, in every command and over MCP, reserves its estimate in the ledger before it is made and settles at its actual cost after, recording its route (`provider:operation:model`), work item, cost and time. Before each call, and for the whole forecast before a run's first call, two limits are checked beside the run's cap:

- **Daily:** spend over the last 24 hours, by every run that uses the ledger.
- **Work item:** all spend recorded under one work item, such as an Objective, a campaign or a session label. It applies only when a work item is named.

A call or run that would cross either limit is refused before any provider call with exit 3 (`cap_refused`). The message names the limit, what is already spent against it and what is left; with `--json`, `error.limit` holds `name` (`daily` or `work-item`), `workItem`, `limitUsd`, `spentUsd`, `requestedUsd` and `ledger`. `--dry-run` reports the spend left under each limit in `spend.limits` (and `withinLimits`), and exits 3 when the forecast does not fit what is left.

| Variable                         | Meaning                                                                    | Default                                                                                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ASSETFORGE_SPEND_LEDGER`        | The ledger file, shared by every run that names the same file              | `$XDG_STATE_HOME/assetforge/spend.jsonl`, else `~/.local/state/assetforge/spend.jsonl`; in a Factory worker (`FACTORY_ISSUE` set), `assetforge-spend.jsonl` in `$FACTORY_STATE_DIR`, else `$TMPDIR` |
| `ASSETFORGE_WORK_ITEM`           | The work item calls are recorded under; `--work-item <label>` overrides it | a Factory worker's Objective, `<GITHUB_REPOSITORY>#<FACTORY_ISSUE>` (or `factory#<n>`); otherwise none: only the daily limit applies                                                                |
| `ASSETFORGE_DAILY_LIMIT_USD`     | The daily limit in USD                                                     | $10                                                                                                                                                                                                 |
| `ASSETFORGE_WORK_ITEM_LIMIT_USD` | The limit per work item in USD                                             | $5                                                                                                                                                                                                  |

When both the environment and the target profile's `spend` set a limit, the stricter applies; when neither does, the default does, so a run is never uncapped. An invalid value is invalid input (exit 2). The ledger is append-only JSON Lines; concurrent runs order their reservations by their appends and never reserve past a limit together. A reservation never settled (a run that crashed) keeps its estimate. The ledger holds no keys or prompts.

Scripted runs (`--provider-script`) are not real spend, so they are excluded: their calls are never written to the ledger and the limits never refuse them, while the run's own `--cap` applies as before. A dry run with a script still prints the limits, with `spend.counted` false. The rule is structural: the provider named `scripted` is unpaid and every other provider name is paid. Tests that prove the limits offline use a script that exports `paid: true`, which the CLI runs under the paid name `scripted-paid`.

## Relightable materials

`style.materials` opts a world into normal, height/depth, emissive, roughness/wetness and wind/flow channels, native 1×/2× (optional 4×) renditions, temporal bounds, target compression and lit-preview commands. Per-asset derivation sources stay separate from the world profile. See [materials.md](materials.md) for the `assetforge materials` command, encoding, provenance and target command contracts.

### Relightable materials

The optional `style.materials` data is validated against the material profile schema. The `materials` command defaults to all standard channels (`normal`, `height`, `emissive`, `roughness`, `wind`), scales `[1, 2]`, and a flicker bound of `0.03` when settings are absent. `channels` can omit any channel or be empty; `scales` may additionally include 4. This does not cause ordinary generation commands to run materials automatically.

Per-channel `encoding` declares `unorm8` and an ordered normalized `range`. `compression` declares the format (`ktx2` or `basis`, delivered in KTX2), version and argv command; `preview` declares its version and argv command. `lightRig` is target-owned JSON data consumed by the preview renderer from the material report. No target light rig is available yet; tests use an explicit synthetic rig. Commands never use shell interpolation and have bounded runtimes. See [materials.md](materials.md) for derivation inputs, defaults, rendition limits and `--dry-run` cost forecasts.
