# Look-dev on Stevie, third pass: before and after (assetforge#129)

These are #129's renders, kept for comparison with the winter-groom pass (assetforge#131, in [`131/`](../131/)) and the face detail pass (assetforge#143, one directory up).

This is one real `assetforge look-dev` run, made on 2026-11-12 (Pacific time) on Stevie's picked model, the same model as #82 and #122: clockgrove/raccoon-world `assets/models/stevie/stevie.glb` (sha256 `81e5ece4…ef3f`, checked before the run). The art (`art/target-profile-3d.json`, `art/style-bible.json`, `art/stevie/character-3d/spec.json` and Stevie's turnaround views) is unchanged since #122's raccoon-world `main` at 4ef1222. #122's renders are kept in [`122/`](../122/) and #82's in [`82/`](../82/) for comparison.

```sh
assetforge look-dev --model assets/models/stevie/stevie.glb \
  --provenance assets/models/stevie/stevie.glb.provenance.json \
  --spec art/stevie/character-3d/spec.json --bible art/style-bible.json \
  --profile art/target-profile-3d.json --work-item clockgrove/assetforge#129
```

The runs called `lookDev` with the options this command passes, through a provider that also saved every reply, so each run can be replayed offline.

**Spend:** $0.39 of the $3.00 cap. The run made 14 calls: 7 restyles on `openai/gpt-image-2`, 1 eye and nose locate, 2 season grooms, 3 markings calls (front, three-quarter and side) and 1 identity score.

**The result does not pass.** `lookdev-markings` still filters it: 11 of 52 measurements drift. Only 2 of them are the tail, and none is the side view's tail rings or tip in summer. The rest move from run to run (below).

**Which run this is.** It is the third real run of this pass, and the best of four:

- **Run 1** ($0.33) was #122's code, recorded for offline replay. Every restyled view paints broad dark rings and a dark tip, and the albedo keeps the restyles' share of dark on the tail. Where no view sees the tail squarely (its underside and the tip's rim), the source texture's own pale tip and rings showed through.
- **Run 2** ($0.38) added the local fill and the restyle prompt's lines on bands and whiskers (below). The tail held in every view and coat. The side view's eye mask did not: the three-quarter view, restyled before the side, painted pale coat on the cheek behind the eye, and it sees that cheek a little more squarely than the side view does.
- **Run 3 (this one)** ($0.39) restyles the square-on views first. The side view sets the cheek's mask and the tail's rings, and the diagonal views continue them.
- **Run 4** ($0.39) was the same code as run 3. It drifted on 13 measurements, a different set. The markings call said the front renders show no tail, and one restyle drew a second iris beside an eye in the close-up.

An offline replay of run 3 with fur turned off, with the 3 markings calls made for real ($0.02), drifted on the tail nowhere and on 8 measurements in all: the three-quarter view's legs and the side view's muzzle, brows and ear rims.

This stage's 4 runs and that replay cost $1.50. One more restyle call, from a run stopped before its first view, is reserved in the spend ledger and never settled.

**For Kirk to compare.** Nothing here is approved. Each `compare-<view>.png` shows, left to right:

1. the approved turnaround view;
2. the model before look-dev;
3. after look-dev, summer coat;
4. after look-dev, winter coat.

The lighting and the fur preview are #122's ([`122/README.md`](../122/README.md) measures them). `unlit-before-<view>.png` and `unlit-after-<view>.png` show the base colour alone.

## What changed

- **Square-on views first.** Look-dev restyles front, side, the other side, back, then three-quarter, the other three-quarter and the high back view. Each view still starts from the model carrying what the earlier views painted. So the side views set the tail's rings and the cheek's mask, and the diagonal views extend them instead of placing their own.
- **Unseen texels follow their neighbours.** A texel no view sees squarely kept the source texture, colour-matched across the whole texture. It is now also matched locally: it takes the mean difference between the projected and the source colour over the seen texels around it in 3D. So the tail's underside and tip rim continue the restyled rings and dark tip, not the source's pale tip.
- **The restyle prompt** asks that where a part alternates bands, each band keeps the width the references give it against its neighbours, and the part ends in the references' colour. It also asks for nothing that stands off the surface, such as whiskers, whose pale streaks broke up the mask.
- **The blend's sharpening** is computed relative to the squarest view's facing, so a high power never underflows to no weight.

Nothing in the code or prompts names a species, a part or a character.

## Checks

All passed except `lookdev-markings`, so the run exits 5 and the result is filtered, not staged. The identity lock is in shadow mode.

| Check                                        | Result                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookdev-albedo-coverage`                    | 81.3% of texels take colour from the restyled views                                                                                                                       |
| `lookdev-seams`                              | 4905 seam edges, mean 7.0 and 95th percentile 16.6 (0–255), against the source texture's 4.8 and 9.9 (#122: 7.2 and 16.6)                                                 |
| `groom-summer-masks`, `groom-winter-masks`   | eyes 3691, nose 4946 and paw pads 50963 texels bare; nothing furred inside them, nothing bare outside                                                                     |
| `groom-summer-render`, `groom-winter-render` | the fur changes 12.9% (summer) and 18.0% (winter) of a view's pixels; speckle it adds: 0.00% of the figure's pixels in every turntable view and the close-up (limit 0.5%) |
| `eyes-catch-light`                           | 2 eyes located, 33 triangles in the `eyes` material, a catch-light in both eyes of the close-up                                                                           |
| glTF validator and budgets                   | 0 errors; 59847 triangles, 2048 px textures, 2 materials, 30 bones                                                                                                        |
| `identity-lock` (shadow)                     | 0.77, over the 0.68 threshold ("the same character with a minor deviation"). #122 scored 0.79                                                                             |
| `lookdev-markings`                           | **failed**: 11 of 52 measurements drift (below)                                                                                                                           |
| `lookdev-compare`                            | the references have no back view, so `compare-back.png` shows the front view in the turnaround column                                                                     |

## Markings

`lookdev-markings` is #122's check, unchanged: its terms are in [`122/README.md`](../122/README.md#markings). A marking drifts at ΔE > 20, or when its contrast or banding flips or keeps under half of the turnaround's.

| View          | Marking                          | ΔE summer | ΔE winter | Measure  | Turnaround → summer, winter (L\*) | Drifts         |
| ------------- | -------------------------------- | --------- | --------- | -------- | --------------------------------- | -------------- |
| front         | dark eye mask                    | 15.8      | 10.6      | contrast | -9.2 → -34.1, -19.8               | no             |
| front         | cream muzzle                     | 9.4       | 2.9       | contrast | 9.2 → 34.1, 19.8                  | no             |
| front         | cream brows                      | 2.0       | 3.1       | banding  | 60.5 → 66.6, 54.2                 | no             |
| front         | rounded pale-rimmed ears         | 2.0       | 14.1      | banding  | 37.6 → 54.9, 54.7                 | no             |
| front         | full ringed tail with a dark tip | 4.2       | 10.1      | contrast | -8.5 → -2.9, -8.0                 | summer         |
| front         | darker streaked back             | 13.5      | 14.4      | banding  | 35.7 → 21.1, 18.8                 | no             |
| front         | warm tan underside               | 13.9      | 15.0      | banding  | 25.7 → 22.0, 21.4                 | no             |
| front         | dark legs and paws               | 5.9       | 2.4       | contrast | -23.6 → -15.6, -9.4               | winter         |
| three-quarter | darker streaked back             | 8.3       | 9.3       | banding  | 22.9 → 9.1, 7.8                   | summer, winter |
| three-quarter | warm tan underside               | 14.4      | 15.1      | contrast | 9.7 → 5.6, 6.9                    | no             |
| three-quarter | dark legs and paws               | 2.9       | 2.8       | contrast | -13.4 → -6.4, -3.8                | summer, winter |
| three-quarter | dark eye mask                    | 2.1       | 4.8       | contrast | -21.3 → -12.9, -5.7               | winter         |
| three-quarter | cream muzzle                     | 2.9       | 8.3       | contrast | 12.5 → 13.1, -0.3                 | winter         |
| three-quarter | cream brows                      | 6.1       | 10.7      | contrast | 9.2 → 6.4, 2.7                    | winter         |
| three-quarter | rounded pale-rimmed ears         | 3.9       | 3.6       | banding  | 45.8 → 40.8, 31.5                 | no             |
| three-quarter | full ringed tail                 | 4.8       | 3.5       | banding  | 39.5 → 39.0, 27.6                 | no             |
| three-quarter | dark tip of tail                 | 6.2       | 6.1       | banding  | 39.7 → 40.4, 33.3                 | no             |
| side          | dark eye mask                    | 2.9       | 3.1       | contrast | -20.3 → -21.7, -20.7              | no             |
| side          | cream muzzle                     | 11.4      | 10.9      | contrast | 23.4 → 12.4, 12.7                 | no             |
| side          | cream brows                      | 15.7      | 26.4      | contrast | 17.9 → 37.1, 46.2                 | winter         |
| side          | pale-rimmed ears                 | 2.3       | 5.9       | banding  | 53.2 → 40.0, 37.6                 | no             |
| side          | darker streaked back             | 1.7       | 3.1       | banding  | 15.7 → 9.6, 8.9                   | no             |
| side          | warm tan underside               | 7.8       | 9.0       | banding  | 17.8 → 16.1, 17.0                 | no             |
| side          | dark legs and paws               | 1.5       | 3.5       | contrast | -19.4 → -17.5, -18.2              | no             |
| side          | ringed tail                      | 5.3       | 3.5       | contrast | -8.9 → -4.6, 2.0                  | winter         |
| side          | dark tip of tail                 | 15.2      | 14.7      | banding  | 42.6 → 39.7, 31.3                 | no             |

What drifts, and what changed since #122:

- **Tail rings and tip.** The restyled views and the albedo carry broad dark rings and a dark tip, and the side view's lit summer tail reads like the turnaround's (`compare-side.png`). Two tail measurements drift. In the front view, summer, the tail box reads darker than the turnaround's tail (median L\* 36 against 40). The body box it is measured against covers most of the render's figure, mask and legs included, and reads about 10 L\* darker than the turnaround's, so the contrast shrinks. #122 found the front view's coat a few L\* darker than the turnaround's in the base colour itself. In the side view, winter, the shell fur, up to 80 mm long on the tail, smears the rings into each other: with fur off, the same tail keeps its banding (the replay above).
- **Eye mask, close-up.** Its outer edge holds on both cheeks in both coats (`compare-close-up.png`); #122's ragged pale patch on one cheek is gone. The side view's mask holds too (#122: thinner than the turnaround's band). The three-quarter mask drifts in winter only, under the longer fur.
- **The rest move between runs.** Run 3's other drifts are the legs, back, muzzle and brows, mostly in winter. Run 4 drifted on brows, underside, legs and muzzle, and run 1, on #122's code, on 12 measurements across muzzle, brows, ears, legs and the tail. #122's five runs named between 4 and 12. The boxes are a vision model's: a box beside a marking can land on a different region of the render than of the turnaround.

`pick` was not run: the result failed a check and is not staged.
