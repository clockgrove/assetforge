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
  "fields": { "semantic": { "role": "actor", "entity": "grove.stevie" } }
}
```

- `kind` selects the generator: `sprite-strip` (key pose, then frame edits) or `still` (one image). A new kind is a new generator.
- `subject` names the bible subject; it defaults to `assetId`.
- `frames.width` and `frames.height` default to the profile's frame size; `frames.count` defaults to 1.
- `anchor` is the pivot in frame coordinates: the bottom centre of the subject is aligned to it. It defaults to the bottom centre of the frame.
- `keyPose` (optional) is an author-approved key pose image; every frame becomes an edit of it.
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
  "subjects": { "stevie": { "description": "a grey adult raccoon with a dark mask" } },
  "mood": ["quiet", "mature", "storybook realism"],
  "notes": ["warm lantern light against cool dusk rain"]
}
```

The subject's references, the perspective sample and a swatch of the palette are sent to the model as image references; the prompt is composed from these fields and the spec, never typed freehand. Post-processing snaps every colour to the palette, and QA compares the candidate with the references.

## Target profile

```json
{
  "name": "clockgrove",
  "license": "MIT",
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
    "palette": "{{output.palette}}",
    "contentHash": "{{output.sha256}}"
  },
  "review": { "path": "review.status", "pending": "pending" },
  "validator": {
    "command": ["pnpm", "--filter", "@clockgrove/assets", "run", "validate", "{{manifest}}"]
  }
}
```

This example follows the public manifest shape in Clockgrove's `packages/assets/docs/pipeline.md`; Clockgrove's real profile, and its validator command, live in Clockgrove (clockgrove/clockgrove#27).

- **Templates.** `"{{a.b}}"` as a whole string inserts the value of any JSON type; `"{{a.b?}}"` drops the key when the value is undefined; `{{a.b}}` inside a longer string interpolates text. An undefined required value is an error.
- **Values available:** `spec.*` (the spec, with its `fields` also merged in), `profile.*` (`values`, `name`, `license`), `bible.version`, `output.*` (`path`, `mediaType`, `extension`, `sha256`, and what the generator adds: `frames`, `anchor`, `bounds`, `palette` for images), `provenance` (the full record) and `run.*` (`runId`, `candidateId`, `pickedAt`).
- **Provenance.** `layout.provenance`, when set, writes the full provenance record as its own file; the template can also embed `{{provenance}}`. The record holds the models, route, prompt, parameters, reference hashes, seed where supported, request IDs, times, cost, provider terms, bible version and license, plus every call.
- **Review.** Assetforge always sets the field at `review.path` to `review.pending` and never writes another value there.
- **Validator.** Run in the target directory after the pick is written, with `{{manifest}}` and `{{media}}` replaced by the written paths. A non-zero exit is reported as a rejection.
- **Media.** Each output declares its own media type and extension; `.gitattributes` in the target decides what Git LFS stores.
