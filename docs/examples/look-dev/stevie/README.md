# Look-dev on Stevie, face detail pass: before and after (assetgrove#143)

This is one real `assetgrove look-dev` run, made on 2026-11-13 (Pacific time) on Stevie's picked model, the same model as #82 to #131. It is the pre-look-dev pick: clockgrove/raccoon-world `assets/models/stevie/stevie.glb` at 7c459ee (sha256 `81e5ece4…ef3f`, checked before the run). raccoon-world `main` has since replaced that file with #131's result (raccoon-world#107). The art (`art/style-bible.json`, `art/stevie/character-3d/spec.json` and Stevie's turnaround views) is unchanged since #122.

#131's renders, Kirk's approved pick, are kept in [`131/`](131/), with #129's in [`129/`](129/), #122's in [`122/`](122/) and #82's in [`82/`](82/).

```sh
assetgrove look-dev --model assets/models/stevie/stevie.glb \
  --provenance assets/models/stevie/stevie.glb.provenance.json \
  --spec art/stevie/character-3d/spec.json --bible art/style-bible.json \
  --profile art/target-profile-3d.json --work-item clockgrove/assetgrove#143
```

**The profile is a copy without `model3d.handoff`.** raccoon-world's `art/target-profile-3d.json` declares `model3d.handoff` with descriptive fields (`container`, `compression`, `textureMediaTypes`, `ktx2`). Assetgrove has refused those since #137 (`model3d.handoff has unknown field(s)`), so the profile no longer loads. The runs used a copy with that section removed. The section does not affect look-dev, and without it the hand-off takes Assetgrove's defaults. As in #129, the runs called `lookDev` with the options this command passes, through a provider that also saved every reply.

**Spend:** $0.42 of the $3.00 cap. The run made 15 calls: 8 restyles on `openai/gpt-image-2` (7 views and the detail view), 1 eye and nose locate, 2 season grooms, 3 markings calls and 1 identity score.

**What #143 asked.** Kirk wants the faces cleaner and more accurate. In #131's close-up the mask ends in hard, blocky patches and reaches onto the jowls, pale streaks run across its lower edge, and the nose and muzzle are soft with a stray line under the nose.

**What was the cause.** Each point in the issue held up:

- **Too few pixels on the face.** Framed on its bounding sphere, the front view's figure filled 337 × 445 of 1024 px (43%), and the face about 200 px across. The close-up enlarged that.
- **Strokes off the surface.** The restyles still drew whiskers, and they projected onto the mask as pale streaks.
- **Views disagreeing on the cheeks.** The diagonal views painted the mask further down the cheeks than the front did. The blend gave each texel to whichever view saw it most squarely, so the mask's edge followed where the views switched, not the painting.

**What changed.**

- **Views framed on the figure.** Each restyled view is framed on the figure's own outline, which fills 86% of its larger side. The front view now fills 84% (front, back and the high view are 84–86%).
- **A detail pass.** One more restyle, from the close-up's direction, framed on the head so its outline fills 80% of 1024 px. The head is located from the model, as the eyes and nose are: the rig template's head region, or the close-up at the target's closest zoom when there is none. The prompt asks it to paint the head's markings and features at full detail, with the references' shape and clean edges, leaving out fine strands drawn standing off the face.
- **The view that sees a texel largest takes it.** A view's weight in the blend is now how large the texel appears in it: pixels per unit of depth times √facing, the square root of the pixel area the texel covers. Before, the weight was facing alone. So the detail view takes the face, and a close square-on view beats a far oblique one. Each view fades out over the outer 8% of its frame, so the detail view hands over smoothly where its frame cuts the figure.
- **The restyle prompt** asks for no strands, bristles or stray hairs lying over the surface, even where the references show them.

Nothing names a species, a part or a character beyond the rig template's head role that look-dev already reads. The winter groom (#131) and the local fill (#129) are unchanged.

**How it got there.**

- **Real run 1** ($0.55). Close-ups from the front and both diagonals at the target's closest zoom. At 1024 px, that zoom spanned the same pixels as at 512, so the close-ups filled only 44–62% of the frame and added little.
- **Real run 2** ($0.52). The same three close-ups, framed on the head. The front close-up restyle was clean and close to the turnaround. The two diagonal close-ups each painted the cheeks their own way, and they won the face's sides and eyes, so the mask came out as a hard bar. Offline replays of this run with its saved restyles showed that the front close-up alone gave the turnaround's face. They also showed that weighting by pixel area (√facing) rather than facing kept the front close-up on the cheeks, without the diagonals' dark jowls.
- **Real run 3 (this one)** ($0.42). One detail view, from the front.

This stage spent $1.48 on real runs. One earlier attempt stopped at the profile error before any call, and cost nothing.

**For Kirk to compare.** Nothing here is approved. Each `compare-<view>.png` shows, left to right:

1. the approved turnaround view;
2. the model before look-dev;
3. after look-dev, summer coat;
4. after look-dev, winter coat.

`compare-close-up.png` is the face against the turnaround's front view. [`131/compare-close-up.png`](131/compare-close-up.png) is #131's. The lighting and the fur preview are #122's ([`122/README.md`](122/README.md) measures them). `unlit-before-<view>.png` and `unlit-after-<view>.png` show the base colour alone.

## The face

In the close-up, the mask is one soft-edged band across the eyes. It meets the pale brows above and the pale muzzle below in clean curves. The muzzle is pale, the nose is clean, and the stray line under it is gone. No pale streaks cross the mask. Its outer ends still reach down at the sides of the face, less than in #131. The turnaround's mask ends higher there. Both coats agree.

The rest holds. The tail keeps its rings and dark tip in both coats, and the winter coat is still the fuller one (`compare-side.png`, `compare-three-quarter.png`). The coat matches #131's.

## Checks

The markings check is advisory (#133). Every other check passed, so the run staged `c1`. The identity lock is in shadow mode.

| Check                                        | Result                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookdev-albedo-coverage`                    | 82.0% of texels take colour from the restyled views                                                                                                                       |
| `lookdev-seams`                              | 4905 seam edges, mean 7.0 and 95th percentile 15.7 (0–255), against the source texture's 4.8 and 9.9 (#131: 6.5 and 14.9)                                                 |
| `groom-summer-masks`, `groom-winter-masks`   | eyes 3804, nose 4446 and paw pads 50963 texels bare; nothing furred inside them, nothing bare outside                                                                     |
| `groom-summer-render`, `groom-winter-render` | the fur changes 13.3% (summer) and 16.1% (winter) of a view's pixels; speckle it adds: 0.00% of the figure's pixels in every turntable view and the close-up (limit 0.5%) |
| `eyes-catch-light`                           | 2 eyes located, 38 triangles in the `eyes` material, a catch-light in both eyes of the close-up                                                                           |
| glTF validator and budgets                   | 0 errors; 59847 triangles, 2048 px textures, 2 materials, 30 bones                                                                                                        |
| `identity-lock` (shadow)                     | 0.80, over the 0.68 threshold ("the same character with a minor deviation"). #131 scored 0.81                                                                             |
| `lookdev-markings` (advisory)                | 7 of 30 measurements drift. The front view's markings call named no marking this run, so the front is not measured                                                        |
| `lookdev-compare`                            | the references have no back view, so `compare-back.png` shows the front view in the turnaround column                                                                     |

## Markings (advisory)

`lookdev-markings` records, but never filters ([decisions.md](../../../decisions.md), "`lookdev-markings` is advisory"). Its terms are in [`122/README.md`](122/README.md#markings).

| View          | Marking                  | ΔE summer | ΔE winter | Measure  | Turnaround → summer, winter (L\*) | Drifts         |
| ------------- | ------------------------ | --------- | --------- | -------- | --------------------------------- | -------------- |
| three-quarter | dark eye mask            | 7.0       | 3.3       | banding  | 61.7 → 68.3, 70.2                 | no             |
| three-quarter | cream muzzle             | 5.8       | 2.3       | banding  | 57.8 → 64.8, 66.1                 | no             |
| three-quarter | cream brows              | 1.4       | 4.4       | contrast | 11.8 → 17.5, 10.1                 | no             |
| three-quarter | pale-rimmed ears         | 1.5       | 1.7       | banding  | 33.7 → 28.4, 29.1                 | no             |
| three-quarter | ringed tail              | 3.2       | 4.7       | banding  | 39.7 → 37.7, 36.1                 | no             |
| three-quarter | dark tip of tail         | 2.6       | 4.9       | banding  | 41.6 → 39.5, 37.6                 | no             |
| three-quarter | dark legs and paws       | 5.1       | 2.1       | contrast | -17.1 → -8.8, -1.4                | winter         |
| side          | darker streaked back     | 1.3       | 2.2       | banding  | 16.5 → 15.6, 14.5                 | no             |
| side          | warm tan underside       | 7.2       | 8.5       | contrast | 8.6 → 4.1, 4.2                    | summer, winter |
| side          | dark legs and paws       | 8.4       | 5.2       | contrast | -27.2 → -11.3, -14.1              | summer         |
| side          | dark eye mask            | 12.9      | 9.4       | banding  | 55.6 → 43.8, 41.8                 | no             |
| side          | cream muzzle             | 11.0      | 11.3      | banding  | 63.2 → 44.5, 46.0                 | no             |
| side          | cream brows              | 23.2      | 19.9      | contrast | 12.6 → 23.3, 23.4                 | summer         |
| side          | rounded pale-rimmed ears | 1.8       | 2.0       | banding  | 50.1 → 53.6, 42.6                 | no             |
| side          | full ringed tail         | 2.2       | 3.7       | contrast | -10.1 → 0.4, 3.0                  | summer, winter |

The three-quarter view's tail keeps its banding in both coats. The side view's "full ringed tail" was measured this run as contrast against the body, which reads the tail's overall lightness, not its bands. #131 discusses that measure.

`pick` was not run. The run is staged for Kirk at `~/work/assetgrove-runs/stevie-lookdev-143/` on the machine that made it.
