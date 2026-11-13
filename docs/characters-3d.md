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

The `.glb` carries the same facts a target compares with the manifest: each animation's `extras.loop` (glTF has no playback-loop flag), and, for template rigs, each clip's `extras.generated` and the asset's `extras.rig`.

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

## Shared rig and generated gait

A target can declare one skeleton template for a kind of character and a gait profile per locomotion clip (assetforge#84; Kirk, 2026-11-10). For such a target, Assetforge does not use the provider's auto-rig and clip library. It fits the template to each character and generates the clips itself, so every character of the kind shares one rig and one motion style. `stage` then makes only the generation and identity calls: the `rig3d` and `clips3d` calls are neither forecast nor made. `assetforge rig` does the same for a model that already exists, such as a wave 0 pick:

```sh
assetforge rig --model c3.glb --provenance c3/provenance.json --spec stevie-3d.json --profile profile.json
assetforge pick --run .assetforge/runs/<run> --candidate c1 --target ../raccoon-world
```

`rig` stages a one-candidate run, `c1`, with the same renders, reasons and provenance as a `stage` candidate. It calls no model and spends nothing. It exits 5 when the re-rigged model fails QA, and the renders are still written. A draft raccoon template and walk are in [examples/raccoon-rig/](examples/raccoon-rig/).

### Contract

The field names below are shared with clockgrove/raccoon-world#39. Names may be added, but none may be renamed without recording it on both issues.

**Profile**

```json
"model3d": {
  "rig": { "template": "rig/raccoon.json", "kind": "raccoon" },
  "gaits": {
    "walk": {
      "footfall": ["hind_l", "fore_l", "hind_r", "fore_r"],
      "dutyFactor": 0.68,
      "strideBodyLengths": 0.3,
      "stepHeightBodyLengths": 0.025,
      "backArchDeg": 12,
      "hipHeightRatio": 1.04,
      "headPitchDeg": 14,
      "tailPitchDeg": 10,
      "tailSwayDeg": 8,
      "speedBodyLengthsPerSecond": 0.35,
      "swingCurlDeg": { "fore": 55, "hind": 12 },
      "reference": "references/stevie/gait-reference"
    }
  }
}
```

- `rig.template` is a path relative to the profile file. `rig.kind` names the kind of character it serves.
- `rig.qa` (optional, added) sets the QA tolerances, in body lengths:
  - `contactBodyLengths`, default 0.01;
  - `slideBodyLengths`, default 0.01;
  - `heelBodyLengths`, default 0.02;

  and `minGirthRatio`, default 0.7.

- `gaits.<family>` is the gait profile of one clip family. A spec family with no gait profile is reported in `missingClips`, never faked.
  - `footfall`: every template foot, in the order the feet touch down. Foot _i_ touches down at phase _i_ ÷ count.
  - `dutyFactor`: the fraction of the cycle each foot is on the ground.
  - `strideBodyLengths`: the distance travelled per cycle, in body lengths. `stepHeightBodyLengths` is the peak swing lift. The cycle lasts stride ÷ speed.
  - `backArchDeg`: positive hunches the back. It is spread over the `spine` joints, and the root tilts against it.
  - `hipHeightRatio`: hip height over shoulder height (the hind legs' upper joints over the fore legs'), so above 1 carries the rump high. The body stands as tall as its legs reach at the ends of the stance with the feet planted. That is why a model whose rest pose has raised heels is lowered until its heels can go down.
  - `headPitchDeg` and `tailPitchDeg`: positive lowers the head or tail. Tail pitch is measured from level.
  - `tailSwayDeg`: the tail's yaw amplitude, in step with the hips.
  - `speedBodyLengthsPerSecond`: the walking speed.
  - Added, optional:
    - `swingCurlDeg: { fore, hind }`: the paw's downward curl at mid-swing, default 0;
    - `hipSwayDeg`: default a third of `tailSwayDeg`;
    - `reference`: a directory of gait reference frames (PNG or JPEG, in name order), relative to the profile;
    - `loop`: default true.

**Template file**

```json
{
  "kind": "raccoon",
  "joints": [
    { "name": "pelvis", "parent": null, "rest": [0, 0.26, -0.08], "role": "pelvis" },
    {
      "name": "wrist_l",
      "parent": "elbow_l",
      "rest": [0.055, 0.03, 0.17],
      "limits": { "x": [-30, 80], "y": [-10, 10], "z": [-10, 10] },
      "stanceLimits": { "x": [-25, 30], "y": [-10, 10], "z": [-10, 10] }
    }
  ],
  "feet": [
    {
      "name": "fore_l",
      "joints": ["shoulder_l", "elbow_l", "wrist_l", "paw_l"],
      "plantigrade": true,
      "pair": "fore"
    }
  ]
}
```

- `rest` is the joint's position as fractions of **body length**, the model's front-to-back extent at rest, tail included. It is in the character's facing frame: +z forward, +y up, +x the character's left. The origin is at the ground, at the bounds' centre on z and on the body's midline on x: the median x of the torso (the middle 40% of the body length, above a third of the model's height), so a tail curled to one side or a splayed leg does not pull it off the body.
- `limits` and `stanceLimits` are degrees of the joint's local rotation from rest, read as X-Y-Z Euler angles. x is flex and extend; a positive x pitches a forward-pointing bone down. An axis without a range is free. `limits` holds in every phase. `stanceLimits` (added) holds for a foot's ankle or wrist while that foot bears weight.
- `role` (added) is `pelvis`, `spine`, `neck`, `head` or `tail`. It tells the gait where the arch, head carriage and tail go.
- `feet[].joints` is the leg chain: upper (hip or shoulder), lower (knee or elbow), ankle (or wrist), toe. `plantigrade: true` stands the foot flat, from ankle to toe, in stance. `name` and `pair` (`fore` or `hind`) are added.

**Template outputs**, added to those above:

- `output.rig`: `{ template, sha256 }`, the template path as declared and the hash of its bytes;
- `output.clips[]`: each clip also has `generated: true` and `speedMps`, the ground speed at which its in-place cycle keeps the stance feet planted. A runtime moves the character at this speed. A target whose manifest has no place for it leaves it out with `model3d.handoff.clipFields` (see Hand-off shape).

### What the rig does

1. **Fit.** The model is normalised as above and baked at its rest pose. Its own skins, joints and clips are dropped; its materials and textures are kept. The template's rest positions are scaled by body length. Each foot first goes to its ground contact on the mesh: the centroid of the ground-contact vertices (within 0.03 body lengths of the lowest) nearest that foot's template contact, searched within 0.15 body lengths. The template contact is the point between ankle and toe for a plantigrade foot, and the toe for a digitigrade one. The ankle and toe move by the whole offset and the knee or elbow by half; the hip or shoulder stays put. Across the foot (x) the offset is applied in full; along it (z), only beyond 0.02 body lengths. A posed scan with a splayed foot is fitted to where the foot actually is. A plantigrade foot whose heel rests raised (its underside's heel end more than 0.02 body lengths above its toe end, sampled on the mesh's surface across the footprint) touches the ground only at its toe, so it is placed by its underside instead: along the foot by the underside's middle, and its ankle and toe stand as far above the underside as the template has them above the ground, so the ankle sits in the mesh's heel. Each joint then moves to the centre of the mesh around it, at most 0.04 body lengths, and only across its bones, so a joint at a corner such as an ankle re-centres sideways.
2. **Skin.** Smooth weights:
   - inverse distance (to the 4th power) to each bone; a plantigrade foot's bone starts 0.35 of its length behind the ankle, so the heel moves with the foot rather than the shin;
   - four rounds of averaging across the mesh, with vertices welded by position;
   - the four largest weights, normalised.

   Every character of the kind gets the template's joint names, in the template's order.

3. **Generate.** Each clip is deterministic and in place, keyed at 30 frames per second, and its last key is its first. The body carries the profile's arch, head, tail, hip sway and a small bob. Each leg is solved by two-bone inverse kinematics, bending in its rest-pose plane:
   - The body stands as high as the shortest leg of each pair reaches at the ends of its stance, so every foot can reach the ground.
   - In stance, the foot is planted on the ground line. Its sole (the lowest of the vertices the ankle and toe carry, and for a plantigrade foot also the lowest along its whole length, heel to toe) touches y = 0, and it moves back at exactly the clip's speed. A plantigrade foot is flat: its underside, heel end to toe end, is turned level.
   - The sole is placed as skinned, not as a rigid foot: each frame, each ankle target is corrected until the skinned sole meets the ground line (or the swing's height), and a plantigrade stance foot is turned until its skinned heel end is level with its toe end. So a heel that the shin carries in part does not lift, and a toe does not sink, as the leg swings back.
   - In the swing, the foot lifts and swings forward, and the paw curls down by `swingCurlDeg`.
4. **QA**, recorded per clip, on the written file's deformed mesh at 24 frames per cycle (more when a low duty factor would leave a foot fewer than four stance frames):
   - `contact-<clip>`: in stance, each foot's sole is within `contactBodyLengths` of the ground (neither floating nor sinking). It slides no more than `slideBodyLengths` in the ground frame that moves at the clip's speed. A plantigrade heel sits no more than `heelBodyLengths` above its toe, measured on the deformed sole: the lowest vertex of its heel end (the rear third of the sole) above the lowest of its toe end (the front third). The reason also gives the heel's height above the toe at rest. A foot with fewer than two stance frames to measure fails.
   - `joint-limits-<clip>`: no joint leaves its `limits`. A weight-bearing ankle or wrist stays within its `stanceLimits` while its foot is down. In the swing only `limits` apply, so a front wrist may curl the paw down. Each failing joint is reported at its worst frame.
   - `skinning-<clip>`: at each knee or elbow and ankle or wrist, the skin's mean distance from the joint's two bones stays at least `minGirthRatio` of its rest value. A lower value means volume is collapsing at the bend.
   - `clip-<clip>` and `loop-<clip>`, as for library clips.
   - `turntable`, as above, plus `<clip>-side.png`, 8 side-view frames of each clip. When the gait has `reference` frames, `<clip>-vs-reference.png` shows those frames under the clip's. A declared `reference` that cannot be read, or holds no frame that decodes, fails `reference-<clip>` with the reason.
   - `compare-<clip>`, when the source model carries its own clip of the family (a provider's library walk): both clips measured the same way on the deformed sole, on the frames each foot is down. It gives the spread of the feet's ground lines and each plantigrade foot's heel above its toe, mean and worst. It is recorded beside QA (`shadow`) and never filters.

   A failing check filters the candidate, and its renders are kept.

5. **Hand-off** is `pick`, as for every candidate. The provenance parameters record `rig`:
   - the kind;
   - the template path and SHA-256;
   - each gait profile and its SHA-256;
   - the source model's SHA-256;
   - the QA tolerances;
   - the fit.

   They also record `targetProfileSha256`. A `rig` run keeps the source's provenance, with its calls, cost and output grant, and adds `parameters.rerig` (`sourceModel`, the source file's name only, and `sourceModelSha256`) and a `rig-generated-gait` step. That step's input is the source model's hash and its output is the re-rigged model's hash.

## Look-dev

`assetforge look-dev` gives a picked, rigged character a base colour in the target's character look, fur groom maps per season and eyes that catch light, and stages it for `pick`: see [look-dev.md](look-dev.md).

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

### Hand-off shape

A target's validator may take fewer clip fields than Assetforge produces, or only a self-contained `.glb` (assetforge#137). The profile declares the shape it takes:

```json
"model3d": {
  "handoff": {
    "clipFields": { "name": "name", "durationMs": "durationMs", "loop": "loop", "generated": "generated" },
    "sideImages": "embedded"
  }
}
```

- `clipFields` maps each field a manifest clip carries to the Assetforge clip field it takes, so a field can also be renamed (`"speed": "speedMps"`). Fields it does not name are left out, and a named field a clip lacks (`generated` on a library clip) is left out of that clip. Without it, every clip field goes as produced.
- `sideImages` is `beside` (the default) or `embedded`. `embedded` moves look-dev's groom maps, tints and eye mask into the `.glb`'s binary chunk and writes no side files, so `output.groom`, `output.textures` and `output.eyes` are not set. `asset.extras.lookdev.images` still maps each field to its image index.
- A malformed `handoff` is refused before any spend (exit 2).

Whatever the shape, `pick` measures each clip's `durationMs` on the `.glb` it hands off (the last key time, unrounded), so it matches what a validator reads from the file.

Clockgrove's model validator (`packages/contracts/src/model-asset.ts`) takes the declaration above. `test/clockgrove-model-validator.test.ts` hands a `rig` and a `look-dev` result to it, vendored in `test/fixtures/clockgrove/`.

## Providers

3D calls go through the provider contract in `src/gateway/provider.ts` (`generateModel`, `rigModel`, `animateModel`); Tripo's HTTP types stay in `src/gateway/tripo.ts`. The routes, prices and the probed clip library are in [models.md](models.md#3d-routes-tripo-not-the-gateway). Meshy is not wired yet: its API account has no credits.

Tests use a scripted provider (`test/fixtures/model3d-script.ts`) that answers with synthetic rigged characters. `pnpm test:real` includes an opt-in Tripo check that reads the credit balance and spends nothing. It skips without `TRIPO_API_KEY`.
