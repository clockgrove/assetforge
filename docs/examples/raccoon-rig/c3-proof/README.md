# Stevie's c3 on the draft raccoon rig (assetforge#84)

The draft raccoon template and walk in this directory's parent, applied to Stevie's wave 0 pick (raccoon-world `references/stevie/3d-wave0-candidates/c3`, Kirk's pick) with `assetforge rig`. The run called no provider and cost $0. These files are for Kirk to judge.

## Inputs

- Source model: `c3.glb`, sha256 `209db8115d4de1ae0a8288f1e4a8e22767a39201c43e2875a37f0a938da226bb`, with its provenance. It is a Tripo model with Tripo's auto-rig and library walk.
- Template: `../raccoon-template.json`, sha256 `8b6c62d8034b462a595b32f214471d5e4aec537113bb0bf3857aa57d256d622a`.
- Walk: `../raccoon-walk.json`, with `reference` set to raccoon-world's `references/stevie/gait-reference/` frames (`adult-fence-walk.png`, `side-crossing.png`, `walk-away.png`).
- Spec: `character-3d`, `assetId` `stevie`, `gait` `quadruped`, `clips` `["walk"]`, `heightM` 0.45, as in c3's provenance.

The throwaway profile was the fragment in `../profile-fragment.json` plus a layout and manifest. `pick` handed the re-rigged model into a throwaway target. Its manifest records `rig: { template, sha256 }` and the walk with `generated: true`, and its provenance records the template, gait and source model hashes.

## Files

- `walk-vs-reference.png`: eight side-view frames of the generated walk (top), above Kirk's gait reference frames (bottom).
- `walk-side.png`: the eight walk frames alone, full size.
- `before-after.png`: the same side camera on c3's original library walk (top) and the generated walk (bottom), eight frames across each cycle.
- `clip-walk-1.png`: one three-quarter frame of the generated walk.
- `qa.json`: every QA reason recorded for the re-rigged candidate, and its clip entry.

## QA: c3's defects

The generated walk passes every check (`qa.json`):

- `contact-walk`: every stance sole is within 2 mm of the ground and slides at most 1.5 mm. Each heel is 0 mm above its toe. The tolerances are 7.7 mm for contact and slide and 15 mm for the heel, scaled from the body length of 0.765 m.
- `joint-limits-walk`: every joint stays within the template's range over 24 frames. Each weight-bearing wrist and ankle stays within its stance range, so none folds in stance.
- `skinning-walk`: girth at the bent leg joints stays at 92% of rest or more, against a minimum of 70%. The ankles and wrists do not pinch.
- `loop-walk`: the last pose returns to the first.

A rough geometric measure compares both walks the same way. It takes the low vertices in each quarter of the rest mesh and samples 24 frames per cycle. It is cruder than the QA's skinned sole, because it counts the bottom of the shin as well as the foot.

|                                                          | c3, library walk                               | c3, generated walk     |
| -------------------------------------------------------- | ---------------------------------------------- | ---------------------- |
| Ground-line spread (lowest point of each paw, max - min) | 57.1 mm                                        | 9.5 mm                 |
| Hind heels above the toe while down                      | 24.1 and 27.4 mm on average (raised, dog-like) | 2.8 and -7.8 mm (flat) |
| Front paws' heel above the fingertips while down         | 4.1 and 9.2 mm on average, up to 17.1 mm       | -5.0 and -5.3 mm       |

In the library walk the hind paws sink 52 to 60 mm below the front paws' ground line, and the hind heels stay raised.
