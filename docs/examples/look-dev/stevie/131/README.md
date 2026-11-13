# Look-dev on Stevie, winter groom: before and after (assetforge#131)

These are #131's renders, Kirk's approved pick (raccoon-world#107), kept for comparison with the face detail pass (assetforge#143) one directory up.

This is one real `assetforge look-dev` run, made on 2026-11-12 (Pacific time) on Stevie's picked model, the same model as #82, #122 and #129: clockgrove/raccoon-world `assets/models/stevie/stevie.glb` (sha256 `81e5ece4…ef3f`, checked before the run). The art (`art/target-profile-3d.json`, `art/style-bible.json`, `art/stevie/character-3d/spec.json` and Stevie's turnaround views) is unchanged since #122's raccoon-world `main` at 4ef1222. #129's renders are kept in [`129/`](../129/), #122's in [`122/`](../122/) and #82's in [`82/`](../82/).

```sh
assetforge look-dev --model assets/models/stevie/stevie.glb \
  --provenance assets/models/stevie/stevie.glb.provenance.json \
  --spec art/stevie/character-3d/spec.json --bible art/style-bible.json \
  --profile art/target-profile-3d.json --work-item clockgrove/assetforge#131
```

As in #129, the runs called `lookDev` with the options this command passes, through a provider that also saved every reply, so each run can be replayed offline.

**Spend:** $0.36 of the $3.00 cap. The run made 14 calls: 7 restyles on `openai/gpt-image-2`, 1 eye and nose locate, 2 season grooms, 3 markings calls (front, three-quarter and side) and 1 identity score.

**What #131 asked.** Kirk judged #129's summer coat "really good" and its winter tail "weird": the winter fur, up to 80 mm on the tail, smeared the rings into a blurred brush and spread the dark tip. Both coats share one base colour, so the cause was winter's groom. The game's fur material reads the same groom maps (clockgrove/clockgrove#242), so the fix is in the maps, not in Assetforge's preview.

**What changed.** Fur is no longer than the marking it grows in. A strand carries its root's colour wherever it lies, so a strand that lies across a marking's edge smears the edge. Each texel's fur length is now cut where a strand lying flat along its comb would reach a marking of another lightness (18 L\* away) or run off the end of its part. The test walks the surface in 3D, on the base colour's L\* smoothed at 0.6% of the model's diagonal, so the coat's fine texture is not an edge. The cut is smoothed over about a centimetre of surface, and a strand keeps at least 30% of its length. Markings broader than the fur keep the full length, so the winter coat still reads longer and fuller. Nothing in it names a species, a part or a character.

**How it got there.**

- **Offline, on #129's run 3.** Replayed from its saved restyles and replies, so the base colour and the markings boxes are #129's and only the groom changes. The winter tail's rings came back crisp in the side and three-quarter views. A version that let fur run off the tail's end kept a wide dark brush at the tip, so running off a part's end now counts as an edge. A floor of 20% to 50% of the length changed little; 30% is used.
- **Real run 1** ($0.38). All tail measurements held in both coats, and only 3 of 44 measurements drifted, all the muzzle. Its restyle, though, broke the mask's outer edge on one cheek with pale streaks in the close-up: a base-colour flaw from that run's restyle, not the groom. This run's spend was booked to the work item `clockgrove/assetforge#129` by mistake.
- **Real run 2 (this one)** ($0.36). The mask's edge holds on both cheeks in the close-up, and every tail measurement holds in both coats.

This stage spent $0.74 on real runs.

**For Kirk to compare.** Nothing here is approved. Each `compare-<view>.png` shows, left to right:

1. the approved turnaround view;
2. the model before look-dev;
3. after look-dev, summer coat;
4. after look-dev, winter coat.

The lighting and the fur preview are #122's ([`122/README.md`](../122/README.md) measures them). `unlit-before-<view>.png` and `unlit-after-<view>.png` show the base colour alone.

## The winter tail, before and after

Before is #129's committed run ([`129/`](../129/)). The same restyles replayed with this pass's groom show the groom's effect alone, with the base colour and boxes unchanged. After is this run. Values are L\*: turnaround → summer, winter.

| View          | Marking (as the markings call named it) | Measure | #129                                    | #129 replayed, new groom   | This run                  |
| ------------- | --------------------------------------- | ------- | --------------------------------------- | -------------------------- | ------------------------- |
| front         | full ringed tail (with a dark tip)      | various | contrast -8.5 → -2.9, -8.0              | contrast -8.5 → -3.3, -4.9 | banding 35.7 → 22.6, 22.2 |
| three-quarter | full ringed tail                        | banding | 39.5 → 39.0, **27.6**                   | 39.5 → 39.6, 37.4          | 39.0 → 41.0, 38.5         |
| three-quarter | dark tip of tail                        | banding | 39.7 → 40.4, 33.3                       | 39.7 → 41.3, 39.5          | 39.5 → 43.2, 39.4         |
| side          | ringed tail                             | various | contrast -8.9 → -4.6, **+2.0** (drifts) | contrast -8.9 → -5.3, -1.6 | banding 41.7 → 42.2, 41.7 |
| side          | dark tip of tail                        | banding | 42.6 → 39.7, 31.3                       | 42.6 → 39.1, 35.9          | 40.8 → 40.9, 42.8         |

Winter's banding now matches summer's within 4 L\* in every view where it is measured as banding. In #129 it was up to 11 L\* under. The side view's "ringed tail" in #129 was measured as contrast against the body, which reads the tail's overall lightness rather than its bands. On that measure the replay still drifts (−1.6).

The winter coat is still the fuller one. In the side view its figure covers 13% more pixels than summer's (#129: 23%), and its fur changes 16.0% of a view's pixels against summer's 12.8%. Its body, neck and cheek fur keep their length. The tail is fuller than summer's, with a soft tuft at the tip.

## Checks

All passed except `lookdev-markings`, so the run exits 5 and the result is filtered, not staged. The identity lock is in shadow mode.

| Check                                        | Result                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookdev-albedo-coverage`                    | 81.9% of texels take colour from the restyled views                                                                                                                       |
| `lookdev-seams`                              | 4905 seam edges, mean 6.5 and 95th percentile 14.9 (0–255), against the source texture's 4.8 and 9.9 (#129: 7.0 and 16.6)                                                 |
| `groom-summer-masks`, `groom-winter-masks`   | eyes 1073, nose 1330 and paw pads 50963 texels bare; nothing furred inside them, nothing bare outside                                                                     |
| `groom-summer-render`, `groom-winter-render` | the fur changes 12.8% (summer) and 16.0% (winter) of a view's pixels; speckle it adds: 0.00% of the figure's pixels in every turntable view and the close-up (limit 0.5%) |
| `eyes-catch-light`                           | 2 eyes located, 5 triangles in the `eyes` material, a catch-light in both eyes of the close-up                                                                            |
| glTF validator and budgets                   | 0 errors; 59847 triangles, 2048 px textures, 2 materials, 30 bones                                                                                                        |
| `identity-lock` (shadow)                     | 0.81, over the 0.68 threshold ("the same character with a minor deviation"). #129 scored 0.77                                                                             |
| `lookdev-markings`                           | **failed**: 8 of 50 measurements drift, none on the tail (below)                                                                                                          |
| `lookdev-compare`                            | the references have no back view, so `compare-back.png` shows the front view in the turnaround column                                                                     |

## Markings

`lookdev-markings` is #122's check, unchanged: its terms are in [`122/README.md`](../122/README.md#markings). A marking drifts at ΔE > 20, or when its contrast or banding flips or keeps under half of the turnaround's. The three-quarter view's legs were not located on the turnaround, so they are not measured.

| View          | Marking                          | ΔE summer | ΔE winter | Measure  | Turnaround → summer, winter (L\*) | Drifts         |
| ------------- | -------------------------------- | --------- | --------- | -------- | --------------------------------- | -------------- |
| front         | dark eye mask                    | 15.7      | 11.7      | banding  | 64.2 → 59.0, 37.1                 | no             |
| front         | cream muzzle                     | 6.2       | 10.7      | contrast | 12.7 → 22.3, 13.2                 | no             |
| front         | cream brows                      | 11.7      | 27.6      | banding  | 58.4 → 67.1, 65.4                 | winter         |
| front         | rounded pale-rimmed ears         | 7.0       | 7.6       | banding  | 36.2 → 18.3, 18.8                 | no             |
| front         | darker streaked back             | 11.1      | 11.8      | banding  | 35.8 → 32.4, 29.8                 | no             |
| front         | warm tan underside               | 14.0      | 14.1      | banding  | 25.8 → 19.7, 19.7                 | no             |
| front         | dark legs and paws               | 11.5      | 14.8      | contrast | -12.7 → -9.7, -12.9               | no             |
| front         | full ringed tail with a dark tip | 3.2       | 3.1       | banding  | 35.7 → 22.6, 22.2                 | no             |
| three-quarter | grey-brown body                  | 8.0       | 8.2       | banding  | 33.5 → 26.3, 24.2                 | no             |
| three-quarter | darker streaked back             | 6.7       | 7.8       | banding  | 22.9 → 12.7, 10.5                 | winter         |
| three-quarter | warm tan underside               | 12.9      | 13.3      | contrast | 8.0 → 4.5, 4.7                    | no             |
| three-quarter | dark eye mask                    | 12.6      | 12.3      | banding  | 58.4 → 46.5, 44.0                 | no             |
| three-quarter | cream muzzle and brows           | 10.3      | 10.3      | banding  | 53.7 → 44.9, 43.1                 | no             |
| three-quarter | pale-rimmed ears                 | 4.1       | 4.0       | banding  | 34.0 → 28.6, 30.4                 | no             |
| three-quarter | full ringed tail                 | 2.4       | 2.2       | banding  | 39.0 → 41.0, 38.5                 | no             |
| three-quarter | dark tail tip                    | 2.0       | 1.8       | banding  | 39.5 → 43.2, 39.4                 | no             |
| side          | dark eye mask                    | 3.6       | 3.8       | contrast | -15.0 → -4.1, -6.0                | summer, winter |
| side          | cream muzzle                     | 24.8      | 23.3      | contrast | 29.9 → 4.6, 6.4                   | summer, winter |
| side          | cream brows                      | 15.3      | 15.1      | contrast | 43.9 → 57.9, 58.0                 | no             |
| side          | rounded pale-rimmed ears         | 1.3       | 2.9       | banding  | 51.9 → 52.1, 48.5                 | no             |
| side          | full ringed tail                 | 2.4       | 2.7       | banding  | 41.7 → 42.2, 41.7                 | no             |
| side          | dark tip of tail                 | 9.2       | 8.1       | banding  | 40.8 → 40.9, 42.8                 | no             |
| side          | darker streaked back             | 1.2       | 2.1       | banding  | 14.3 → 12.5, 11.8                 | no             |
| side          | warm tan underside               | 7.1       | 6.5       | banding  | 21.0 → 20.7, 17.7                 | no             |
| side          | dark legs and paws               | 8.4       | 8.3       | contrast | -21.8 → -6.5, -7.2                | summer, winter |

What drifts:

- **Nothing on the tail.** In both coats the rings keep their bands and the tip stays dark (`compare-side.png`, `compare-three-quarter.png`).
- **Side view, mask, muzzle and legs, in both coats.** These drift in both coats alike, so they come from the base colour or the boxes, not the groom. The side view's mask runs back from the eye as in #129 (`compare-side.png`), and its own box reads as dark as the turnaround's (L\* 24.7 against 28.3). The box it is measured against overlaps the mask, so it reads L\* 28.8 where the turnaround's reads 43.3. The muzzle box reads L\* 29.3 where the turnaround's reads 53.5, on a muzzle the render shows short and pale.
- **Front brows and three-quarter back, winter only.** The drifting measurements move from run to run, as in #129: real run 1 drifted on the muzzle alone.

`pick` was not run: the result failed a check and is not staged.
