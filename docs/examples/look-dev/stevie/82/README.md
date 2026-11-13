# Look-dev on Stevie: before and after (assetforge#82)

These are #82's renders, kept for comparison with the second pass (assetforge#122, in [`122/`](../122/)) the third (assetforge#129, in [`129/`](../129/)) the winter-groom pass (assetforge#131, in [`131/`](../131/)) and the face detail pass (assetforge#143, one directory up). They were rendered under the turntable lighting of the time (ambient 0.35 and one key light), which brings each render to 0.4–0.7 of its base colour's brightness ([#122's README](../122/README.md) measures it).

This is one real `assetforge look-dev` run, made on 2026-11-12 (the second, after review: the catch-light moved into the eye material and the restyle prompt asks for markings kept in place, shape and contrast), on Stevie's picked model. The model is clockgrove/raccoon-world `assets/models/stevie/stevie.glb` (sha256 `81e5ece4…ef3f`; wave 0 candidate c3, re-rigged on the #39 rig). The run used that repository's `art/target-profile-3d.json`, `art/style-bible.json` and `art/stevie/character-3d/spec.json`.

```sh
assetforge look-dev --model assets/models/stevie/stevie.glb \
  --provenance assets/models/stevie/stevie.glb.provenance.json \
  --spec art/stevie/character-3d/spec.json --bible art/style-bible.json \
  --profile art/target-profile-3d.json --work-item clockgrove/assetforge#82
```

**Spend:** $0.32 of the $3.00 cap; the forecast was $1.81. It made 11 calls: 7 restyles on `openai/gpt-image-2`, 1 eye and nose locate, 2 season grooms and 1 identity score.

**For Kirk to compare.** Nothing here is approved. Each `compare-<view>.png` shows, left to right:

1. the approved turnaround view;
2. the model before look-dev;
3. after look-dev, summer coat;
4. after look-dev, winter coat.

The views are front, three-quarter, side, back, and `close-up`, a close-up at the target's closest zoom (Stevie at a third of a 1440 px screen). The single renders are `before-<view>.png` and `after-<season>-<view>.png`. The after renders draw Assetforge's own shell-fur preview, driven by the season's groom maps. The target's fur material is clockgrove/clockgrove#242.

`unlit-before-<view>.png` and `unlit-after-<view>.png` show the base colour alone, with no lighting or fur. Assetforge's turntable lighting darkens every render to about 0.7 of the albedo, while the turnaround is evenly lit. Compare the colours with these.

**Checks** (all passed except the identity lock, which is in shadow mode):

| Check                                        | Result                                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookdev-albedo-coverage`                    | 82.4% of texels take colour from the restyled views; the rest keep the source texture, colour-matched                                                                                                       |
| `lookdev-seams`                              | 4905 seam edges, mean difference 6.4 and 95th percentile 14.7 (0–255), against the source texture's 4.8 and 9.9                                                                                             |
| `groom-summer-masks`, `groom-winter-masks`   | bare masks of eyes 4605, nose 4130 and paw pads 50963 texels, each non-empty and all at zero length; no zero-length texel outside the masks                                                                 |
| `groom-summer-render`, `groom-winter-render` | map-driven shell fur changes 12.1% (summer) and 15.3% (winter) of a turntable view's pixels                                                                                                                 |
| `eyes-catch-light`                           | 2 eyes located, 53 triangles in the `eyes` material, a catch-light in 2 of 2 eyes of the close-up (peak luminance 255). The catch-light is the `eyes` material's emissive texture; the base colour has none |
| glTF validator and budgets                   | 0 errors; 59847 triangles, 2048 px textures, 2 materials, 30 bones                                                                                                                                          |
| `identity-lock` (shadow)                     | 0.66, under the 0.68 threshold ("the same character with a minor deviation"); the first run scored 0.60                                                                                                     |
| `lookdev-compare`                            | the bible names front, three-quarter and side turnaround views, so `compare-back.png` shows the front view in the turnaround column                                                                         |

`pick` into a scratch checkout of raccoon-world wrote the `.glb`, the base colour, the eye mask, the six groom maps and the winter tint beside it. Raccoon World's validator accepted the result. Raccoon World's own manifest template does not print `output.groom`, `output.textures` or `output.eyes` yet. Handing the result in is that repository's follow-up.

The 3D identity numbers for these renders are in [decisions.md](../../../../decisions.md), under "3D after look-dev".
