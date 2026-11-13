# Look-dev on Stevie, second pass: before and after (assetforge#122)

This is one real `assetforge look-dev` run, made on 2026-11-12 (Pacific time) on Stevie's picked model, the same model as #82: clockgrove/raccoon-world `assets/models/stevie/stevie.glb` (sha256 `81e5ece4…ef3f`, checked before the run). The art (`art/target-profile-3d.json`, `art/style-bible.json`, `art/stevie/character-3d/spec.json` and Stevie's turnaround views) is raccoon-world `main` at e113a72. #82's renders are kept in [`82/`](82/) for comparison.

```sh
assetforge look-dev --model assets/models/stevie/stevie.glb \
  --provenance assets/models/stevie/stevie.glb.provenance.json \
  --spec art/stevie/character-3d/spec.json --bible art/style-bible.json \
  --profile art/target-profile-3d.json --work-item clockgrove/assetforge#122
```

**Spend:** $0.34 of the $3.00 cap. The forecast was $1.89. The run made 14 calls: 7 restyles on `openai/gpt-image-2`, 1 eye and nose locate, 2 season grooms, 3 markings calls (front, three-quarter and side) and 1 identity score. It is the third real run of this pass. Runs 1 and 2 ($0.33 and $0.32) showed the defects fixed before this one: background projected onto the inner legs, and markings boxes on a small figure. Four probe calls of the markings route cost $0.02. The pass spent $1.02 in all.

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
| front         | 0.97              | 0.95   | 1.00   | 0.68        | 0.57   | 0.53   |
| three-quarter | 0.95              | 0.94   | 0.97   | 0.70        | 0.57   | 0.54   |
| side          | 1.03              | 1.01   | 1.03   | 0.66        | 0.53   | 0.51   |
| back          | 1.05              | 1.03   | 1.06   | 0.46        | 0.38   | 0.38   |

The figure's median coat colour (CIELAB) against the turnaround's:

| View          | Turnaround              | #82 lit, summer        | This pass, lit, summer | This pass, lit, winter | This pass, unlit        |
| ------------- | ----------------------- | ---------------------- | ---------------------- | ---------------------- | ----------------------- |
| front         | L\* 45.6, a 5.6, b 11.5 | L\* 19.3, a 3.0, b 6.4 | L\* 37.3, a 4.7, b 9.0 | L\* 37.7, a 4.4, b 8.3 | L\* 39.7, a 5.2, b 10.4 |
| three-quarter | L\* 45.5, a 5.7, b 11.3 | L\* 20.3, a 3.3, b 7.0 | L\* 37.0, a 4.6, b 8.8 | L\* 36.9, a 4.4, b 8.3 | L\* 40.7, a 5.3, b 10.3 |
| side          | L\* 44.3, a 5.6, b 10.8 | L\* 19.2, a 3.2, b 6.7 | L\* 40.7, a 4.8, b 9.2 | L\* 40.5, a 4.5, b 8.5 | L\* 41.2, a 5.2, b 9.9  |

The lit renders now read at the base colour's brightness, where #82's read at about half of it. The coat is still a few L\* darker and a little less warm than the turnaround: that is the base colour itself (unlit, L\* 40–41 against 44–46), not the lighting.

## Checks

All passed except `lookdev-markings`, so the run exits 5 and the result is filtered, not staged. The identity lock is in shadow mode.

| Check                                        | Result                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookdev-albedo-coverage`                    | 81.7% of texels take colour from the restyled views                                                                                                                       |
| `lookdev-seams`                              | 4905 seam edges, mean 6.4 and 95th percentile 14.5 (0–255), against the source texture's 4.8 and 9.9                                                                      |
| `groom-summer-masks`, `groom-winter-masks`   | eyes 3930, nose 4524 and paw pads 50963 texels bare; nothing furred inside them, nothing bare outside                                                                     |
| `groom-summer-render`, `groom-winter-render` | the fur changes 12.7% (summer) and 17.3% (winter) of a view's pixels; speckle it adds: 0.00% of the figure's pixels in every turntable view and the close-up (limit 0.5%) |
| `eyes-catch-light`                           | 2 eyes located, 42 triangles in the `eyes` material, a catch-light in both eyes of the close-up                                                                           |
| glTF validator and budgets                   | 0 errors; 59847 triangles, 2048 px textures, 2 materials, 30 bones                                                                                                        |
| `identity-lock` (shadow)                     | 0.78, over the 0.68 threshold ("the same character with a minor deviation"). #82 scored 0.66                                                                              |
| `lookdev-markings`                           | **failed**: 7 of 48 measurements drift (below)                                                                                                                            |
| `lookdev-compare`                            | the references have no back view, so `compare-back.png` shows the front view in the turnaround column                                                                     |

## Markings

`lookdev-markings` measured each marking the markings call named, in the three views with their own turnaround view (Stevie's references have no back view, so the back is not measured). ΔE76 is the marking's colour against the turnaround's. Contrast is the marking's L\* minus that of the coat beside it. A marking drifts at ΔE > 20, or when its contrast flips or keeps under half of the turnaround's (for a turnaround contrast of 8 L\* or more).

| View          | Marking                  | ΔE summer | ΔE winter | Contrast (L\*): turnaround → summer, winter | Drifts         |
| ------------- | ------------------------ | --------- | --------- | ------------------------------------------- | -------------- |
| front         | dark eye mask            | 10.5      | 7.6       | -4.1 → -9.0, -8.2                           | no             |
| front         | cream muzzle             | 1.5       | 3.1       | 12.8 → 22.2, 17.4                           | no             |
| front         | cream brows              | 10.7      | 6.4       | 18.6 → 39.6, 32.5                           | no             |
| front         | rounded pale-rimmed ears | 5.4       | 9.3       | 1.3 → 2.3, 17.2                             | no             |
| front         | darker streaked back     | 7.4       | 7.7       | 0.3 → -3.2, -3.3                            | no             |
| front         | warm tan underside       | 13.2      | 15.1      | 3.9 → 5.0, 3.3                              | no             |
| front         | dark legs and paws       | 5.7       | 1.7       | -23.7 → -16.3, -7.8                         | winter         |
| front         | full ringed tail         | 5.7       | 7.3       | -2.5 → -3.8, -5.2                           | no             |
| front         | dark tip of tail         | 2.1       | 1.2       | -8.9 → -2.3, 1.3                            | summer, winter |
| three-quarter | dark eye mask            | 11.5      | 3.6       | -2.4 → -11.3, -2.8                          | no             |
| three-quarter | cream muzzle             | 2.8       | 6.0       | 7.7 → 16.7, 4.2                             | no             |
| three-quarter | cream brows              | 0.2       | 1.7       | 5.8 → 16.4, 6.3                             | no             |
| three-quarter | pale-rimmed ears         | 2.8       | 2.4       | -0.4 → 0.4, 0.4                             | no             |
| three-quarter | full ringed tail         | 4.0       | 3.8       | -0.4 → 0.0, 0.0                             | no             |
| three-quarter | dark tail tip            | 3.3       | 2.4       | -2.0 → -1.6, -0.5                           | no             |
| side          | dark eye mask            | 21.8      | 21.9      | -31.4 → 2.6, 2.3                            | summer, winter |
| side          | cream muzzle             | 5.0       | 5.5       | 10.4 → 10.1, 8.7                            | no             |
| side          | cream brows              | 11.6      | 4.5       | 32.6 → 29.8, 17.7                           | no             |
| side          | rounded pale-rimmed ears | 2.8       | 3.0       | -0.5 → 11.7, 8.7                            | no             |
| side          | warm tan underside       | 12.4      | 13.3      | 12.7 → 5.5, 5.6                             | summer, winter |
| side          | darker streaked back     | 0.9       | 2.3       | -4.7 → 2.0, 1.7                             | no             |
| side          | dark legs and paws       | 10.3      | 10.2      | -26.2 → -18.1, -16.9                        | no             |
| side          | full ringed tail         | 2.2       | 3.1       | -2.3 → 1.1, 1.5                             | no             |
| side          | dark tail tip            | 3.8       | 5.0       | 2.0 → 4.6, 3.3                              | no             |

What drifts, by eye on the compare sheets:

- **Side view, eye mask.** Real: in profile the model's mask is a faint smudge behind the eye where the turnaround has a dark band. The restyle of the side view did not keep it.
- **Side view, warm tan underside.** Real, but mild: the belly is less warm and less pale than the turnaround's.
- **Front view, dark legs (winter) and dark tail tip.** Partly the measurement: the winter coat's longer fur softens the legs, and the tail tip is small at this size.

The muzzle, brows and ear rims hold in every measured view, and the tail rings read clearly on the back view. Run 2's check named different markings, among them the side muzzle and brows and the front back stripe. The boxes are a vision model's, so a marking near the threshold can pass in one run and fail in the next. The check filters; it never approves.

`pick` was not run: the result failed a check and is not staged. Handing a result into raccoon-world is that repository's follow-up, after Kirk judges it.

The 3D identity rerun on these renders (assetforge#122, Outcome 5) is not done yet: the gateway relay shut part-way through it. Its numbers go in [decisions.md](../../../decisions.md), beside #82's "3D after look-dev".
