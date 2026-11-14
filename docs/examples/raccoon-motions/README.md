# Stevie's idle, sniff, eat, play and shelter on the shared rig (draft, assetgrove#135)

This is one real `assetgrove rig` run, made on 2026-11-13, on Stevie's picked model: clockgrove/raccoon-world `assets/models/stevie/stevie.glb` (sha256 `2680c2c4f6d9…0985`, checked before the run), with its look-dev maps beside it. The profile is a scratch copy of raccoon-world's `art/target-profile-3d.json` (its `rig/raccoon.json` template and walk unchanged) with `profile-fragment.json`'s `model3d.motions` merged in. The spec is raccoon-world's `art/stevie/character-3d/spec.json`, whose clips are `idle`, `walk`, `sniff`, `eat`, `play` and `shelter`.

```sh
assetgrove rig --model assets/models/stevie/stevie.glb \
  --provenance assets/models/stevie/stevie.glb.provenance.json \
  --spec art/stevie/character-3d/spec.json --profile art/target-profile-3d.json
```

No model was called and nothing was spent. The run took about 45 s on a laptop, most of it rendering.

**Result.** Every check passed (exit 0), so the candidate is staged for the person to judge; nothing here is approved. The fit's body length is 0.765 m. `qa.json` holds every reason and the clip fields.

| Family    | Kind                     | Length  | Checks                                                                         |
| --------- | ------------------------ | ------- | ------------------------------------------------------------------------------ |
| `idle`    | looping                  | 4.0 s   | clip, loop, contact, joint limits, skinning                                    |
| `sniff`   | one-shot from `idle`     | 3.1 s   | clip, ends (0.03° from the idle's first pose), contact, joint limits, skinning |
| `eat`     | one-shot from `idle`     | 3.5 s   | clip, ends, contact (the paw only while down), joint limits, skinning          |
| `play`    | one-shot from `idle`     | 2.4 s   | clip, ends, contact (not during the hop), joint limits, skinning               |
| `shelter` | looping                  | 2.4 s   | clip, loop, contact, joint limits, skinning                                    |
| `walk`    | gait (unchanged, as #84) | 0.743 s | as before; the walk's clip is byte-for-byte the one before this change         |

## Files

- `profile-fragment.json`: the five motions, for raccoon-world to adopt or replace. Every number is a draft.
- `<family>-preview.webp`: the looping preview the person sees, from the three-quarter camera at 10 frames a second.
- `<family>-side.png`: 8 side-view frames over the clip.
- `qa.json`: the run's checks, clips and missing clips.

## What each motion is

The poses are drafted from raccoon-world's motion briefs (`art/stevie/<family>/brief.json`), not from reference footage.

- **idle**: standing on all fours with the back gently hunched. It breathes (the arch rises and falls), the head turns a little to one side and back, the tail sways and the ears settle.
- **sniff**: from the idle, the head goes down to the ground and sweeps right then left with the paws planted, then comes back up.
- **eat**: the head goes down to a morsel, the right fore paw lifts and curls as if holding food, and the head bobs twice as it chews. Then it is back to the idle.
- **play**: a play bow, with the front low, the rump up and the tail up and swishing. Then a small hop with all four feet off the ground, a landing in the bow, and back to the idle.
- **shelter**: hunkered low with the back hunched, the head down, the tail wrapped to one side and the ears back, with a small shiver. It loops for as long as the rain lasts.

## How it got there

The first pass failed `joint-limits` on `eat`, `play` and `shelter`:

- A 30° back arch rolled the shoulders and twisted the stance wrists past ±15°. Motions now tilt the root against the arch as the walk does, so the same arch numbers mean the same carriage in both.
- The lifted paw at 0.05 body lengths and the hop at 0.03 pushed the elbows past ±20° of roll. They were lowered to 0.04 and 0.02.
- A 14° bow flexed the stance wrists past 30°. The bow was lowered to 9°.

## Limits of this draft

The motions are subtle: the template's limits (wrist roll ±15° in stance, ears ±5°) bound how far the paws and ears can go. A raccoon sitting up on its haunches to eat with both hands needs a pose where the fore feet bear no weight and the hind legs fold deeply. The declaration can express it (lift both fore feet, raise the body and pitch it up), but these drafts do not attempt it.
