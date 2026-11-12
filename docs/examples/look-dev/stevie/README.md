# Look-dev on Stevie: before and after (assetforge#82)

This is one real `assetforge look-dev` run, made on 2026-11-12, on Stevie's picked model. The model is clockgrove/raccoon-world `assets/models/stevie/stevie.glb` (sha256 `81e5ece4…ef3f`; wave 0 candidate c3, re-rigged on the #39 rig). The run used that repository's `art/target-profile-3d.json`, `art/style-bible.json` and `art/stevie/character-3d/spec.json`.

```sh
assetforge look-dev --model assets/models/stevie/stevie.glb \
  --provenance assets/models/stevie/stevie.glb.provenance.json \
  --spec art/stevie/character-3d/spec.json --bible art/style-bible.json \
  --profile art/target-profile-3d.json --work-item clockgrove/assetforge#82
```

**Spend:** $0.33 of the $3.00 cap; the forecast was $1.81. It made 11 calls: 7 restyles on `openai/gpt-image-2`, 1 eye and nose locate, 2 season grooms and 1 identity score.

**For Kirk to compare.** Nothing here is approved. Each `compare-<view>.png` shows, left to right:

1. the approved turnaround view;
2. the model before look-dev;
3. after look-dev, summer coat;
4. after look-dev, winter coat.

The views are front, three-quarter, side, back, and `close-up`, a close-up at the target's closest zoom (Stevie at a third of a 1440 px screen). The single renders are `before-<view>.png` and `after-<season>-<view>.png`. The after renders draw Assetforge's own shell-fur preview, driven by the season's groom maps. The target's fur material is clockgrove/clockgrove#242.

`unlit-before-<view>.png` and `unlit-after-<view>.png` show the base colour alone, with no lighting or fur. Assetforge's turntable lighting darkens every render to about 0.7 of the albedo, while the turnaround is evenly lit. Compare the colours with these.

**Checks** (all passed except the identity lock, which is in shadow mode):

| Check                                        | Result                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `lookdev-albedo-coverage`                    | 82.4% of texels take colour from the restyled views; the rest keep the source texture, colour-matched                |
| `lookdev-seams`                              | 4905 seam edges, mean difference 6.4 and 95th percentile 14.5 (0–255), against the source texture's 4.8 and 9.9      |
| `groom-summer-masks`, `groom-winter-masks`   | 60752 bare texels (eyes, nose, paw pads), all at zero length; no zero-length texel outside the masks                 |
| `groom-summer-render`, `groom-winter-render` | map-driven shell fur changes 12.2% (summer) and 15.3% (winter) of a turntable view's pixels                          |
| `eyes-catch-light`                           | 2 eyes located, 66 triangles in the `eyes` material, a catch-light in both eyes of the close-up (peak luminance 255) |
| glTF validator and budgets                   | 0 errors; 59847 triangles, 2048 px textures, 2 materials, 30 bones                                                   |
| `identity-lock` (shadow)                     | 0.60, under the 0.68 threshold ("partly the same")                                                                   |

`pick` into a scratch checkout of raccoon-world wrote the `.glb`, the base colour, the eye mask, the six groom maps and the winter tint beside it. Raccoon World's validator accepted the result. Raccoon World's own manifest template does not print `output.groom`, `output.textures` or `output.eyes` yet. Handing the result in is that repository's follow-up.

The 3D identity numbers for these renders are in [decisions.md](../../../decisions.md), under "3D after look-dev".
