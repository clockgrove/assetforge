# Stevie's detail levels and phone tier (assetforge#136)

This is one real `assetforge lod` run, made on 2026-11-13, on Stevie's picked model: clockgrove/raccoon-world `assets/models/stevie/stevie.glb` (sha256 `2680c2c4f6d9…0985`, checked before the run), with its look-dev maps beside it. No model was called and nothing was spent.

1. `assetforge rig` re-rigged it with every clip of the spec, using a scratch copy of raccoon-world's `art/target-profile-3d.json` with [raccoon-motions](../../raccoon-motions/)' motions merged in. The clips were `idle`, `walk`, `sniff`, `eat`, `play` and `shelter`. That gave the same result as that example, and it was picked into a scratch target.
2. `assetforge lod` made the chain from the picked file. The same scratch profile, with its `handoff` replaced by `{ "lods": "files" }` (see below), declares raccoon-world's own `lods` and `tiers`. The spec is raccoon-world's `art/stevie/character-3d/spec.json` with `"tierClass": "character"`.

```sh
assetforge lod --model assets/models/stevie/stevie.glb \
  --provenance assets/models/stevie/stevie.glb.provenance.json \
  --spec spec.json --profile art/target-profile-3d.json
```

The run took about 15 s on a laptop. Every check passed (exit 0), so the chain is staged for the person to judge. Nothing here is approved.

## Result

| Level | Ratio | Shown down to | Triangles | Kept vertices | Silhouette vs full: worst (mean), 4 views + 24 clip frames |
| ----- | ----- | ------------- | --------- | ------------- | ---------------------------------------------------------- |
| 0     | 1     | 0.15          | 59,847    | all           | —                                                          |
| 1     | 0.33  | 0.05          | 19,749    | 13,554        | 0.78% (0.65%)                                              |
| 2     | 0.1   | 0             | 5,975     | 5,042         | 2.93% (2.11%)                                              |

- **Tiers.** The desktop tier (60,000 triangles, 2048 px) is served by the main file and its levels as they are. The **phone tier** (20,000 triangles, 1024 px, raccoon-world's `character` class) gets levels 1 and 2 (19,749 and 5,975 triangles). Its embedded base colour and catch-light, and all eight side maps (groom, winter tint, eye mask), are at 1024 px. So the chain satisfies the phone tier.
- **Rig.** Every level has the same 30-joint skeleton, inverse binds and six clips. Every kept vertex's position, joints, weights and UVs are byte-for-byte its source vertex's (`lod-<n>-rig`), so the levels deform with the same weights and line up with the base colour and every side map.

## Files

- `lods-<view>.png`: levels 0, 1 and 2 side by side in each turntable view.
- `lods-clips.png`: one row per level, each clip at its middle frame.
- `tier-phone.png`: the phone tier's first level in the four views, with its 1024 px textures.
- `qa.json`: every check's reason, the chain (`output.chain`), and the `.glb` and side files the hand-off writes, with their manifest fields.
- `profile-fragment.json`: what a target adds to use the chain. It sets `model3d.lods` (raccoon-world already declares it), `model3d.handoff.lods`, and the manifest fields that list the level and tier files.

## Packaging

The run used `"lods": "files"`: one `.glb` per level (`stevie.glb`, `stevie.lod1.glb`, `stevie.lod2.glb`) and one per phone level (`stevie.phone.lod1.glb`, `stevie.phone.lod2.glb`), with the phone's side maps beside them as `stevie.phone.<map>.png`. Each file's own triangles and `lods` (1) are what a validator measures in it.

Clockgrove's validator sums triangles over every mesh in a file (clockgrove/clockgrove#304). Until that is fixed, `MSFT_lod` levels inside one file (`"embedded"`, the default) would be counted as 85,571 triangles.

Each level file carries its own copy of the 2048 px embedded textures, so the three default-tier files are about 20 MB each. Texture encoding (KTX2) and mesh compression (meshopt) stay raccoon-world's build step.
