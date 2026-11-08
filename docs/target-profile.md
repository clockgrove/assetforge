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

- `kind` selects the generator: `sprite-strip` (frame edits of an approved key pose) or `still` (one image). A new kind is a new generator.
- `subject` names the bible subject; it defaults to `assetId`.
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

`perspectiveDescription` (optional) tells the vision QA pass what view the perspective sample shows; without it QA compares against the sample alone. The subject's references, the perspective sample and a swatch of the palette are sent to the model as image references; the prompt is composed from these fields and the spec, never typed freehand. Post-processing snaps every colour to the palette, and QA compares the candidate with the references.

## Target profile

```json
{
  "name": "clockgrove",
  "license": "MIT",
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

An optional `identity` object configures identity lock scoring: `mode` (`shadow`, the default, scores without filtering; `enforce` filters candidates below the threshold; `off`), `threshold` (0 to 1, default 0.625, provisional; see [decisions.md](decisions.md)) and `question` (`score` or `boolean`). See [generation-knobs.md](generation-knobs.md#identity-lock-scoring).

This example follows the public manifest shape in Clockgrove's `packages/assets/docs/pipeline.md`; Clockgrove's real profile, and its validator command, live in Clockgrove (clockgrove/clockgrove#27).

- **Style.** `style` is the world's style profile: alpha mode (`soft` or `binary`, with a `threshold`), colour rule (`full` or `palette`) and edges (`antialiased` or `crisp`). The sheet import path follows it ([sheet-import.md](sheet-import.md#style-profile)). It is optional, and templates can read it as `{{profile.style}}`.
- **Templates.** `"{{a.b}}"` as a whole string inserts the value of any JSON type; `"{{a.b?}}"` drops the key when the value is undefined; `{{a.b}}` inside a longer string interpolates text. An undefined required value is an error.
- **Values available:** `spec.*` (the spec, with its `fields` also merged in), `profile.*` (`values`, `name`, `license`), `bible.version`, `output.*` (`path`, `mediaType`, `extension`, `sha256`, and what the generator adds: `frames`, `anchor`, `bounds`, `palette` for images; imported strips add `jitterPx` and set `palette` only under a palette colour rule), `provenance` (the full record) and `run.*` (`runId`, `candidateId`, `pickedAt`).
- **Provenance.** Every pick carries its full provenance record into the target. `layout.provenance`, when set, writes it as its own file at that path; the template can also embed `"{{provenance}}"`; with neither, it is written beside the media file as `<media path>.provenance.json`. The record holds the models, route, prompt, parameters, reference hashes, seed where supported, request IDs, times, cost, provider terms, bible version and license, plus every call. Each call marks `costSource` (`provider` or `estimate`) and `requestIdSource` (`provider`, or `local` when the gateway reported no ID and Assetforge generated one).
- **Review.** Assetforge always sets the field at `review.path` to `review.pending` and never writes another value there.
- **Validator.** Run in the target directory after the pick is written, with `{{manifest}}` and `{{media}}` replaced by the written paths. A non-zero exit is reported as a rejection.
- **Media.** Each output declares its own media type and extension; `.gitattributes` in the target decides what Git LFS stores.

## Relightable materials

`style.materials` opts a world into normal, height/depth, emissive, roughness/wetness and wind/flow channels, native 1×/2× (optional 4×) renditions, temporal bounds, target compression and lit-preview commands. Per-asset derivation sources stay separate from the world profile. See [materials.md](materials.md) for the `assetforge materials` command, encoding, provenance and target command contracts.

### Relightable materials

The optional `style.materials` data is validated against the material profile schema. The `materials` command defaults to all standard channels (`normal`, `height`, `emissive`, `roughness`, `wind`), scales `[1, 2]`, and a flicker bound of `0.03` when settings are absent. `channels` can omit any channel or be empty; `scales` may additionally include 4. This does not cause ordinary generation commands to run materials automatically.

Per-channel `encoding` declares `unorm8` and an ordered normalized `range`. `compression` declares the format (`ktx2` or `basis`, delivered in KTX2), version and argv command; `preview` declares its version and argv command. `lightRig` is target-owned JSON data consumed by the preview renderer from the material report. No target light rig is available yet; tests use an explicit synthetic rig. Commands never use shell interpolation and have bounded runtimes. See [materials.md](materials.md) for derivation inputs, defaults, rendition limits and `--dry-run` cost forecasts.
