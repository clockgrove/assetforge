# Stevie's c3 on the draft raccoon rig (assetforge#84)

The draft raccoon template and walk in this directory's parent, applied to Stevie's wave 0 pick (raccoon-world `references/stevie/3d-wave0-candidates/c3`, Kirk's pick) with `assetforge rig`. The run called no provider and cost $0. These files are for Kirk to judge.

## Inputs

- Source model: `c3.glb`, sha256 `209db8115d4de1ae0a8288f1e4a8e22767a39201c43e2875a37f0a938da226bb`, with its provenance. It is a Tripo model with Tripo's auto-rig and library walk.
- Template: `../raccoon-template.json`, sha256 `8b6c62d8034b462a595b32f214471d5e4aec537113bb0bf3857aa57d256d622a`.
- Walk: `../raccoon-walk.json`, with `reference` set to raccoon-world's `references/stevie/gait-reference/` frames (`adult-fence-walk.png`, `roof-ridge-walk-hd.png`, `side-crossing.png`, `walk-away.png`).
- Spec: `character-3d`, `assetId` `stevie`, `gait` `quadruped`, `clips` `["walk"]`, `heightM` 0.45, as in c3's provenance.

The throwaway profile was the fragment in `../profile-fragment.json` plus a layout and manifest. `pick` handed the re-rigged model into a throwaway target. Its manifest records `rig: { template, sha256 }` and the walk with `generated: true`, and its provenance records the template, gait and source model hashes.

## Files

- `walk-vs-reference.png`: eight side-view frames of the generated walk (top), above Kirk's gait reference frames (bottom).
- `walk-side.png`: the eight walk frames alone, full size.
- `before-after.png`: the same side camera on c3's original library walk (top) and the generated walk (bottom), eight frames across each cycle.
- `clip-walk-1.png`: one three-quarter frame of the generated walk.
- `qa.json`: every QA reason recorded for the re-rigged candidate, and its clip entry.

## QA: c3's defects

The generated walk passes every check (`qa.json`). Every figure below is Assetforge's own, recorded in `qa.json`, measured on the deformed mesh of the written file:

- `contact-walk`: every stance sole is within 0.1 mm of the ground and slides at most 1.4 mm. The heel is measured on the deformed sole: the lowest vertex of its heel end (the rear third of the sole) above the lowest of its toe end. Every heel is within 0.1 mm of its toe in stance. The tolerances are 7.7 mm for contact and slide and 15 mm for the heel, scaled from the body length of 0.765 m.
- `joint-limits-walk`: every joint stays within the template's range over 24 frames. Each weight-bearing wrist and ankle stays within its stance range, so none folds in stance.
- `skinning-walk`: girth at the bent leg joints stays at 91% of rest or more, against a minimum of 70%. The ankles and wrists do not pinch.
- `loop-walk`: the last pose returns to the first.
- `compare-walk` (recorded beside QA, never a filter): c3's own library walk and the generated walk, measured the same way on the same skinned soles, on the frames each foot is down.

c3's rest pose stands with its heels down (each 2 mm or less from its toe, the "at rest" figure in `contact-walk`). Its raised hind ankles and its uneven ground line come from Tripo's library walk, which `compare-walk` measures:

|                                                  | c3, library walk                                    | c3, generated walk                       |
| ------------------------------------------------ | --------------------------------------------------- | ---------------------------------------- |
| Ground-line spread (each paw's sole while down)  | 57.2 mm                                             | 0.0 mm                                   |
| Hind heels above the toe while down              | 37.2 and 38.4 mm on average, up to 40.1 mm (raised) | 0.3 and 0.3 mm on average, up to 4.1 mm  |
| Front paws' heel above the fingertips while down | 4.2 and 7.8 mm on average, up to 22.7 mm            | 1.2 and 1.3 mm on average, up to 13.6 mm |

"While down" is every frame on which the paw's sole is within the contact tolerance of its lowest, so it includes the frames around touchdown and lift-off. The front paws' worst generated figure is a paw starting to curl at lift-off; in stance proper (`contact-walk`) every heel is within 0.1 mm of its toe.
