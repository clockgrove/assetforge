# Real-time 3D characters

Real-time 3D characters (wave 0 of [PLAN.md](PLAN.md); assetforge#72) are made with the same `stage` and `pick` commands as other kinds. `stage` takes a `character-3d` spec and the bible's approved references of the character. It generates rigged, animated binary glTF (`.glb`) candidates within the cost cap and QA-filters them, then writes turntable renders for the person. `pick` writes the candidate the person chooses into a target whose profile declares `model3d`. Assetforge never picks.

```sh
assetforge stage --spec stevie-3d.json --bible bible.json --profile profile.json --dry-run
assetforge stage --spec stevie-3d.json --bible bible.json --profile profile.json   # TRIPO_API_KEY
assetforge pick --run .assetforge/runs/<run> --candidate c2 --target ../raccoon-world
```

## Contract

The field names below are shared with clockgrove/raccoon-world#39. Fields may be added, but not renamed without recording the change on both issues.

**Spec**

```json
{
  "kind": "character-3d",
  "assetId": "stevie",
  "subject": "stevie",
  "gait": "quadruped",
  "clips": ["idle"],
  "heightM": 0.45,
  "fields": { "semantic": { "role": "actor", "entity": "grove.stevie" } }
}
```

- `gait` (`quadruped` or `biped`) chooses the rig.
- `clips` lists the animation families to retarget, named as they will be in the model.
- `fields` reaches the templates as `spec.fields.*`.
- `heightM` (optional, added here) scales the model to that standing height in metres. Without it, the provider's units are kept as metres.

**Target profile**

```json
"model3d": {
  "format": "glb",
  "budgets": { "triangles": 40000, "textureMaxPx": 2048, "materials": 4, "bones": 80, "lods": 1 },
  "forward": "+z",
  "units": "m",
  "turntable": { "sizePx": 512 },
  "loopTolerance": { "rotationDeg": 2, "translationFraction": 0.01 }
}
```

- `forward` is `+z` (default), `-z`, `+x` or `-x`.
- `turntable.sizePx` defaults to 512.
- `loopTolerance` (optional, added here) defaults to 2° and 1% of the model's height.
- A profile without `model3d` is refused before any spend (exit 2).

**Template outputs**

| Field                                                                                        | Value                                     |
| -------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `output.path`, `output.sha256`                                                               | set at hand-off                           |
| `output.mediaType`                                                                           | `model/gltf-binary`                       |
| `output.extension`                                                                           | `glb`                                     |
| `output.triangles`, `output.textureMaxPx`, `output.materials`, `output.bones`, `output.lods` | measured                                  |
| `output.clips`                                                                               | one `{ name, durationMs, loop }` per clip |
| `output.bounds`                                                                              | `{ min, max }` in metres                  |

Also available:

- `output.gait`;
- `output.missingClips`, as `{ family, why }`: families the library has no close clip for, which do not fail the candidate;
- `output.unmatchedClips`, as `{ family, why }`, when present: library clips that were requested but not returned, each of which fails its `clip-<family>` check;
- `output.identity`, the identity score.

## What a candidate is

1. **Generate** (`model3d` route). The bible references whose `subject` is the character, and that are not the perspective sample, are the approved turnaround. Each reference's view is read from its role:
   - `front`, `back` and `right` are those views;
   - `side` or `left` is the left view;
   - `three-quarter` is the three-quarter view.

   With a front view and at least one of left, back or right, Tripo builds from all of them (`multiview_to_model`); otherwise it builds from the front, or the first, reference.

   The profile's triangle budget goes with the call (`maxTriangles`, Tripo's `face_limit`), because Tripo otherwise returns about 400K triangles.

2. **Rig** (`rig3d` route): the provider's auto-rig for the gait. The route's `rigTypes` maps a gait to the provider's rig type.
3. **Clips** (`clips3d` route): the provider's library clips, retargeted onto the rig. The route's `library` maps gait → family → `{ clip, loop }`. A family with no library entry is reported as missing for the candidate. It is never faked, and the candidate is not refused for it. Each returned animation is renamed after its family. For a looping family, the last key of every channel is set to its first, which closes the loop.
4. **Normalise.** The scene gets a single root node that:
   - turns the model from the route's `forward` (the provider's facing, `+z` by default; Tripo's models face `+x`, as measured on the real Stevie run) to the profile's `forward`;
   - scales it to `heightM`;
   - stands it on y = 0 and centres it on x and z.
5. **QA**, recorded per candidate. All before the pick:
   - `gltf-validator`: the Khronos glTF validator (the `gltf-validator` package) reports no errors. Warnings are listed but do not fail.
   - `mesh-hierarchy`: a single scene root with triangle geometry.
   - `budget-<name>`: triangles, texture size, materials, bones and LODs are each within the profile's budget. A value over budget fails with the measured value, for example `triangles 52000 over the budget of 40000`.
     - Texture size is the largest edge of any embedded image.
     - Bones are the unique joints over all skins.
     - LODs are 1 plus the `MSFT_lod` levels.
   - `skeleton`: a skin with joints.
   - `clip-<family>`: the clip exists, lasts more than zero and animates joints of the skin. A missing family passes with the reason `missing, not faked`.
   - `loop-<family>`: for a looping family, the last pose returns to the first within the loop tolerance.
   - `turntable`: renders written from a fixed camera and light. The camera is 15° above the horizon and framed on the rest-pose bounds. The light is one directional light plus ambient. The renders are front, three-quarter, side and back, relative to the model's facing, plus 4 three-quarter frames of each clip. They go in `<run>/c<n>-character-3d/` for every candidate, including filtered ones.
   - `identity-lock`: the identity call scores the front and three-quarter renders, side by side, against the character's approved references. It uses the profile's identity mode, which is shadow by default (the score is recorded and nothing is filtered). The record comes from the bible:
     - the subject's references;
     - its description as signature features;
     - the palette;
     - versioned with the bible.

A candidate that fails a filtering check is not staged. It is listed in the run's `rejections` with its reasons, its cost and its renders.

## Spend

`stage` reserves every call against the cap before the first one: generation, rigging, clips and identity, for every candidate. A run that does not fit is refused (exit 3). `--dry-run` prints the forecast without a key. The default routes reserve $1.001 per candidate, so 4 candidates reserve $4.004 against the $5 cap. Each call settles at the cost Tripo reports (its credits × $0.01) or, failing that, at its estimate. Every candidate's provenance carries its own `costUsd`.

## Hand-off

`pick` writes the `.glb` through the profile's `layout` and `manifest` templates, then runs its validator, as for other kinds:

- the manifest has review pending;
- the digital source type is embedded in the glTF's JSON chunk (`KHR_xmp_json_ld`).

The provenance records:

- models and routes;
- prompts and parameters, including the views, the rig type, the library clips, missing families and the channels closed for loops;
- reference hashes, request IDs (Tripo task IDs) and costs;
- provider terms;
- the `outputGrant` combined over every call.

A grant the target cannot accept is refused with exit 7 before anything is written (see [target-profile.md](target-profile.md)). Tripo on paid credits is relabelled to the target's licence. A free-plan grant such as Meshy's CC BY 4.0 ships only when the profile lists it in `acceptedLicenses`, and its credit line is then `{{provenance.outputGrant.attribution}}`.

## Providers

3D calls go through the provider contract in `src/gateway/provider.ts` (`generateModel`, `rigModel`, `animateModel`); Tripo's HTTP types stay in `src/gateway/tripo.ts`. The routes, prices and the probed clip library are in [models.md](models.md#3d-routes-tripo-not-the-gateway). Meshy is not wired yet: its API account has no credits.

Tests use a scripted provider (`test/fixtures/model3d-script.ts`) that answers with synthetic rigged characters. `pnpm test:real` includes an opt-in Tripo check that reads the credit balance and spends nothing. It skips without `TRIPO_API_KEY`.
