# Look-dev on Stevie, second pass: before and after (assetforge#122)

These are #122's renders, kept for comparison with the third pass (assetforge#129, in [`129/`](../129/)) and the winter-groom pass (assetforge#131, one directory up).

This is one real `assetforge look-dev` run, made on 2026-11-12 (Pacific time) on Stevie's picked model, the same model as #82: clockgrove/raccoon-world `assets/models/stevie/stevie.glb` (sha256 `81e5ece4…ef3f`, checked before the run). The art (`art/target-profile-3d.json`, `art/style-bible.json`, `art/stevie/character-3d/spec.json` and Stevie's turnaround views) is raccoon-world `main` at 4ef1222. #82's renders are kept in [`82/`](../82/) for comparison.

```sh
assetforge look-dev --model assets/models/stevie/stevie.glb \
  --provenance assets/models/stevie/stevie.glb.provenance.json \
  --spec art/stevie/character-3d/spec.json --bible art/style-bible.json \
  --profile art/target-profile-3d.json --work-item clockgrove/assetforge#122
```

**Spend:** $0.34 of the $3.00 cap. The forecast was $1.89. The run made 14 calls: 7 restyles on `openai/gpt-image-2`, 1 eye and nose locate, 2 season grooms, 3 markings calls (front, three-quarter and side) and 1 identity score.

**Which run this is.** It is the eighth real run of this pass. Runs 1 and 2 ($0.33 and $0.32) showed background projected onto the inner legs and markings boxes on a small figure, fixed before run 3. Run 3 ($0.34) was the first proof, and review found that its side view's eye mask and tan underside did not hold. Runs 4 to 7 ($0.34, $0.35, $0.36, $0.33) traced why and tried the fixes:

- **Run 4** was run 3's code with the reworked markings check. The side restyle drew a strong mask, but around an eye drawn higher than the mesh's own. The three-quarter restyle painted pale coat on the same cheek, and the projection averaged the two to a grey smudge. Replaying the projection offline from run 4's restyles showed that sharper view weights alone made the side worse.
- **Run 5** asked the restyle to keep the eyes, nose, mouth and other features where the render has them, and to place markings relative to them. The side's eye moved onto the mesh's eye, and the side mask's banding held, but the blend was still grey.
- **Run 6** restyled the views in turn, each from the model carrying what earlier views painted. The tail rings then agreed across views. The side mask still averaged to grey.
- **Run 7** added the blend that hands a texel to the squarest view where views disagree. The side mask, muzzle and brows held, but the side underside was too dull.
- **Run 8 (this one)** also says that broad colour regions, such as an underside, are markings too.

This stage's five runs cost $1.72 and its identity rerun $0.43. The first stage spent $1.02 on runs 1 to 3 and four probe calls of the markings route, and $0.43 on its identity rerun.

**For Kirk to compare.** Nothing here is approved. Each `compare-<view>.png` shows, left to right:

1. the approved turnaround view;
2. the model before look-dev;
3. after look-dev, summer coat;
4. after look-dev, winter coat.

The before and after renders share one lighting, Assetforge's default preview lighting: ambient 0.6 and a key of 0.4 from above-left of the camera, with one automatic exposure for the run, and highlights rolled off rather than clipped. The after renders draw Assetforge's shell-fur preview, driven by each season's groom maps. The target's fur material is clockgrove/clockgrove#242. `unlit-before-<view>.png` and `unlit-after-<view>.png` show the base colour alone.

## Lit renders against the turnaround

Lit-to-unlit figure brightness (mean luminance of the lit render's figure over the unlit one's; 1 is the base colour's own brightness):

| View          | This pass: before | summer | winter | #82: before | summer | winter |
| ------------- | ----------------- | ------ | ------ | ----------- | ------ | ------ |
| front         | 0.97              | 0.96   | 0.98   | 0.68        | 0.57   | 0.53   |
| three-quarter | 0.95              | 0.94   | 0.94   | 0.70        | 0.57   | 0.54   |
| side          | 1.03              | 1.00   | 1.00   | 0.66        | 0.53   | 0.51   |
| back          | 1.05              | 1.05   | 1.07   | 0.46        | 0.38   | 0.38   |

The figure's median coat colour (CIELAB) against the turnaround's (run 3 is this pass's first proof):

| View          | Turnaround              | #82 lit, summer        | Run 3 lit, summer      | This run, lit, summer   | This run, lit, winter   | This run, unlit         |
| ------------- | ----------------------- | ---------------------- | ---------------------- | ----------------------- | ----------------------- | ----------------------- |
| front         | L\* 45.6, a 5.6, b 11.5 | L\* 19.3, a 3.0, b 6.4 | L\* 37.3, a 4.7, b 9.0 | L\* 39.1, a 4.7, b 9.1  | L\* 39.0, a 4.6, b 8.9  | L\* 40.6, a 5.3, b 10.8 |
| three-quarter | L\* 45.5, a 5.7, b 11.3 | L\* 20.3, a 3.3, b 7.0 | L\* 37.0, a 4.6, b 8.8 | L\* 40.6, a 5.4, b 10.7 | L\* 39.8, a 5.2, b 10.4 | L\* 44.6, a 6.3, b 12.8 |
| side          | L\* 44.3, a 5.6, b 10.8 | L\* 19.2, a 3.2, b 6.7 | L\* 40.7, a 4.8, b 9.2 | L\* 44.8, a 6.0, b 11.6 | L\* 44.2, a 5.8, b 11.3 | L\* 45.3, a 6.7, b 13.1 |

The lit renders read at the base colour's brightness, where #82's read at about half of it. The side view's lit coat now matches the turnaround. The front and three-quarter views are still a few L\* darker: that is the base colour itself (unlit, L\* 40.6 and 44.6), not the lighting.

## Checks

All passed except `lookdev-markings`, so the run exits 5 and the result is filtered, not staged. The identity lock is in shadow mode.

| Check                                        | Result                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookdev-albedo-coverage`                    | 81.5% of texels take colour from the restyled views                                                                                                                       |
| `lookdev-seams`                              | 4905 seam edges, mean 7.2 and 95th percentile 16.6 (0–255), against the source texture's 4.8 and 9.9 (run 3: 6.4 and 14.5)                                                |
| `groom-summer-masks`, `groom-winter-masks`   | eyes 3423, nose 4335 and paw pads 50963 texels bare; nothing furred inside them, nothing bare outside                                                                     |
| `groom-summer-render`, `groom-winter-render` | the fur changes 14.1% (summer) and 18.1% (winter) of a view's pixels; speckle it adds: 0.00% of the figure's pixels in every turntable view and the close-up (limit 0.5%) |
| `eyes-catch-light`                           | 2 eyes located, 38 triangles in the `eyes` material, a catch-light in both eyes of the close-up                                                                           |
| glTF validator and budgets                   | 0 errors; 59847 triangles, 2048 px textures, 2 materials, 30 bones                                                                                                        |
| `identity-lock` (shadow)                     | 0.79, over the 0.68 threshold ("the same character with a minor deviation"). #82 scored 0.66; run 3, 0.78                                                                 |
| `lookdev-markings`                           | **failed**: 5 of 40 measurements drift, all on the tail (below)                                                                                                           |
| `lookdev-compare`                            | the references have no back view, so `compare-back.png` shows the front view in the turnaround column                                                                     |

## Markings

`lookdev-markings` measured each marking the markings call named, in the three views with their own turnaround view (Stevie's references name no back view, so the back is not measured). ΔE76 is the marking's colour against the turnaround's. **Contrast** is the marking's L\* minus that of the coat beside it, used when the turnaround's is 8 L\* or more. Otherwise it is **banding**: the spread of L\* inside the marking's own box (80th minus 20th percentile), so a ringed or banded marking is held to its bands. A marking drifts at ΔE > 20, or when its contrast or banding flips or keeps under half of the turnaround's. A marking the turnaround shows and a render does not also drifts.

| View          | Marking                  | ΔE summer | ΔE winter | Measure  | Turnaround → summer, winter (L\*) | Drifts         |
| ------------- | ------------------------ | --------- | --------- | -------- | --------------------------------- | -------------- |
| front         | dark eye mask            | 11.6      | 6.7       | banding  | 61.8 → 50.1, 62.3                 | no             |
| front         | cream muzzle             | 5.9       | 14.8      | contrast | 17.3 → 23.0, 9.7                  | no             |
| front         | cream brows              | 9.1       | 12.5      | contrast | 10.5 → 32.0, 30.8                 | no             |
| front         | rounded pale-rimmed ears | 1.2       | 7.3       | banding  | 52.3 → 49.6, 41.7                 | no             |
| front         | full ringed tail         | 2.0       | 6.2       | contrast | -12.2 → -3.2, -6.7                | summer         |
| front         | dark tail tip            | 5.6       | 2.2       | contrast | -9.6 → -1.5, -2.2                 | summer, winter |
| three-quarter | dark eye mask            | 0.8       | 2.5       | banding  | 61.8 → 57.5, 53.1                 | no             |
| three-quarter | cream muzzle             | 15.0      | 7.0       | banding  | 59.4 → 55.7, 55.3                 | no             |
| three-quarter | cream brows              | 1.2       | 2.3       | contrast | 14.3 → 15.3, 10.2                 | no             |
| three-quarter | pale-rimmed ears         | 2.9       | 3.5       | banding  | 33.3 → 29.3, 28.5                 | no             |
| three-quarter | full ringed tail         | 2.5       | 1.4       | banding  | 39.0 → 33.0, 25.5                 | no             |
| three-quarter | dark tail tip            | 5.9       | 6.3       | banding  | 41.0 → 37.6, 26.6                 | no             |
| three-quarter | dark legs and paws       | 10.6      | 4.1       | contrast | -13.2 → -15.2, -7.4               | no             |
| side          | darker streaked back     | 0.9       | 0.5       | banding  | 15.8 → 14.1, 13.1                 | no             |
| side          | warm tan underside       | 1.5       | 3.7       | contrast | 9.2 → 7.3, 5.7                    | no             |
| side          | dark legs and paws       | 2.7       | 3.1       | contrast | -24.9 → -20.9, -17.7              | no             |
| side          | dark eye mask            | 9.5       | 7.0       | banding  | 55.6 → 49.3, 47.3                 | no             |
| side          | cream muzzle and brows   | 2.5       | 1.3       | banding  | 54.6 → 48.9, 45.2                 | no             |
| side          | rounded pale-rimmed ears | 2.6       | 1.4       | banding  | 49.8 → 40.7, 36.7                 | no             |
| side          | full ringed tail         | 4.6       | 4.9       | contrast | -11.0 → -3.5, 0.2                 | summer, winter |

What drifts, and what changed since run 3:

- **Tail rings and tip, front and side views.** Real. The dark rings are narrower than the turnaround's broad bands, so the tail reads less dark against the body (contrast −11 to −12 L\* in the turnaround, −3 to 0 here). The tip is tan more than dark, as `cast` also says. Winter's longer, frosted fur softens the rings further.
- **Side view, eye mask.** It holds now (run 3: contrast −31.4 → +2.6 L\*, drifting). The mask is dark behind the eye in both coats, though thinner than the turnaround's band.
- **Side view, warm tan underside.** It holds now (run 3: 12.7 → 5.5 L\*, drifting; this run 9.2 → 7.3 and 5.7).
- **Front view, legs.** Not drifting in this run. Run 7 named them, against a chest that was then too grey.

The muzzle, brows and ear rims hold in every measured view. The boxes are a vision model's, so a marking near the threshold can pass in one run and fail in the next: the five runs of this stage named between 4 and 12 drifting measurements. The check filters; it never approves.

`pick` was not run: the result failed a check and is not staged. Handing a result into raccoon-world is that repository's follow-up, after Kirk judges it.

The 3D identity rerun on these renders (assetforge#122, Outcome 5) is in [decisions.md](../../../../decisions.md), "3D after look-dev, second pass", beside #82's numbers. With `score` at 0.68, 7 of the 10 looked-dev renders pass; under #82's lighting, none did. `cast` now calls 3 of 10 on-model (#82: none; run 3: 1). Its reasons for the other 7 are pale flecks breaking up the eye mask, the tan tail tip, mottled tail bands, and the close-up's large head. Identity on 3D stays shadow-only.
