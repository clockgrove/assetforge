# Animation that holds together

PRD §5.2. A strip, whether imported from a sheet ([sheet-import.md](sheet-import.md)) or generated, is checked against its family's motion template and by loop and continuity QA. The person picking sees an onion-skin sheet and a looping preview. A single bad frame is repaired by a per-frame fix. Assetforge never approves a strip; it measures, reports and shows.

## The commands

```sh
# Written families: write-families already runs the pixel checks and writes the previews.
pnpm assetforge write-families --import .assetforge/imports/<import> --target ../clockgrove

# The full QA on one strip, identity flicker included (vision calls within the cap).
pnpm assetforge animation-qa --strip walk-right.png --profile profile.json --family walk-right \
  --out .assetforge/animation [--subject jimothy] [--no-vision] [--cap 1] [--dry-run] [--json]

# Or on every family an import wrote.
pnpm assetforge animation-qa --import .assetforge/imports/<import> --profile profile.json

# Fix frame 5 from its approved neighbour 4 (or from the key pose).
pnpm assetforge fix-frame --strip walk-right.png --profile profile.json --family walk-right \
  --frame 5 --from 4 --out .assetforge/fixes/walk-right [--cap 2] [--dry-run] [--json]
pnpm assetforge fix-frame ... --frame 5 --key-pose key-pose.png
```

Every command follows the CLI contract ([decisions.md](decisions.md#cli-contract-assetforge21-2026-11-07)): `--json`, the exit codes, `--dry-run` (a forecast that spends nothing and needs no key) and `--provider-script`. `animation-qa` exits 5 when any check fails, after writing the report and the previews.

## Motion templates

A template is data. Assetforge ships idle, walk, sniff, eat, play and shelter; a target adds its own, or replaces a built-in by name, in its target profile:

```json
{
  "animation": {
    "templates": [
      {
        "name": "sleep",
        "loop": true,
        "frames": { "min": 2, "max": 8 },
        "beats": [
          { "name": "exhale", "at": 0, "contact": true },
          { "name": "inhale", "at": 0.5, "contact": true }
        ],
        "contact": "all",
        "silhouette": { "min": 0, "max": 0.1 }
      }
    ],
    "thresholds": { "anchorDriftPx": 1.5 }
  }
}
```

| Field              | Meaning                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `name`             | The family it serves. It also matches `<name>-<suffix>`, so `walk` serves `walk-right` and `walk-left`.                 |
| `loop`             | The last frame must flow into the first.                                                                                |
| `frames`           | The allowed frame count, `{ min, max }`.                                                                                |
| `cycleMs`          | Optional allowed cycle length (frames × the profile's `frames.durationMs`).                                             |
| `beats`            | Named moments, each `at` a fraction of the cycle (frame `round(at × count)`), `contact: true` when the feet are down.   |
| `contact`          | Frames whose feet must sit on the ground line: `all` (a walk keeps its feet on the ground), `beats` or `none`.          |
| `silhouette`       | Allowed change between consecutive frames, `1 − IoU` of their alpha masks: an idle barely moves, a walk must move some. |
| `footprintDriftPx` | Optional per-family footprint drift bound (the walk's feet swing, so its bound is wider).                               |

| Built-in  | Loop | Frames | Contact | Silhouette change | Beats                                      |
| --------- | ---- | ------ | ------- | ----------------- | ------------------------------------------ |
| `idle`    | yes  | 2–12   | all     | 0–0.15            | rest, breathe-in                           |
| `walk`    | yes  | 4–16   | all     | 0.01–0.4          | contact-a, passing-a, contact-b, passing-b |
| `sniff`   | yes  | 2–12   | all     | 0–0.25            | neutral, nose-down                         |
| `eat`     | yes  | 2–12   | all     | 0–0.3             | reach, bite, chew                          |
| `play`    | yes  | 3–16   | beats   | 0.01–0.5          | crouch (contact), airborne, land (contact) |
| `shelter` | yes  | 2–12   | all     | 0–0.15            | huddle, tremble                            |

The walk also bounds its cycle to 400–2000 ms. A family no template matches still gets the loop and continuity checks, with the defaults, and its report says no template matched.

## The checks

Deterministic checks come first and are measured on pixels, at the style profile's alpha cut (binary) or alpha 128 (soft), so painterly, flat-cartoon and pixel-art strips are measured alike. Each failing check names the frame and the reason.

| Check              | Fails when                                                                                                       | Bound (profile `animation.thresholds`) |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `template`         | the frame count (or the cycle length) is outside the template                                                    | the template                           |
| `beats`            | the strip has fewer frames than the template has beats                                                           | the template                           |
| `ground-contact`   | a contact frame's feet baseline is off the ground line (the anchor's row)                                        | `groundTolerancePx`, default 1         |
| `anchor-drift`     | a frame's centre of mass is off the anchor column                                                                | `anchorDriftPx`, default 1             |
| `footprint-drift`  | the centre of a contact frame's footprint (the span of its bottom rows) moves away from the first frame's        | `footprintDriftPx`, default 2          |
| `silhouette`       | consecutive frames change more or less than the template allows                                                  | the template                           |
| `loop-seam`        | the last frame → first frame change exceeds the largest change between consecutive frames by more than the ratio | `loopSeamRatio`, default 1.5           |
| `identity-flicker` | the vision model labels a consecutive pair `flicker` at or above the cutoff, or its reply is unreadable          | `flickerCutoff`, default 0.7           |

Identity flicker is the only check that needs a model, because pixels cannot tell a pose change from a design change. It is one `flicker` call per consecutive pair (and the seam, on a loop), each with the two frames. Its model is the `flicker` route (default `google/gemini-3-flash`, estimated $0.02 a call), which a routes file can change. Every call's model, request ID, pair, label, confidence, cutoff and decision is appended to `flicker.jsonl` in the output directory: the logged data the cutoff is chosen from. The default cutoff of 0.7 is a starting point until enough decisions are logged. `--no-vision` skips the check and the report says so; it never counts as a pass. This checks frame-to-frame consistency within a strip only; scoring a character against its identity lock is separate work.

## Onion skin and loop preview

For each family, beside the strip:

- `<family>.onion.png`: one cell per frame, the frame over its previous frame (tinted red) and next frame (tinted blue), with the ground line and the anchor marked and the frame number underneath. On a loop the first cell shows the last frame and the last cell shows the first, so the seam is visible. Frames with a failed check have a red border. A last cell overlays every frame faintly, so drift shows at a glance.
- `<family>.webp`: a lossless animated WebP that loops forever at the profile's frame duration (default 120 ms), on a neutral backdrop so soft alpha reads correctly in any viewer.

Both are plain image files (`image/png`, `image/webp`), so a target's review shows them as it shows any image. `write-families` writes them into the import's `preview/` directory; `animation-qa` writes them, with `<family>.qa.json`, into `--out`.

## Per-frame fix

A reference-guided edit of one frame. Image 1 is the approved neighbour frame (`--from <n>`) or the approved key pose (`--key-pose <file>`); image 2 is the bad frame. The `edit` route makes one call, reserved against the cap (default $2) first. The result is matted when it has no alpha, scaled so its area matches the reference's, registered on the anchor and styled to the profile. Only that frame changes; every other frame stays byte-identical.

`--out` receives the fixed strip, its provenance, its QA report and new previews. The provenance carries the strip's own record forward (read from `--provenance`, or `<strip>.provenance.json` beside it) and adds the call (model, route, prompt, seed, request ID, time, cost), a `fixes` entry (frame, source, the frame's pixel hashes before and after) and an `edit-frame` transform on that frame. A strip with a model-edited frame is disclosed as a composite with trained algorithmic media unless it was fully generated already. The fix never writes into a target and never sets a review value: the person picks the fixed strip and hands it off.

## Proof on real art

The owner's Jimothy sheet is never committed. `test/real/animation.real.ts` runs on it when `JIMOTHY_SHEET` points at a local copy and `JIMOTHY_GROUPING` at an author-confirmed grouping: it imports, writes the families into a temporary target, runs the QA and writes the onion sheets and previews to `JIMOTHY_OUT` (default a temporary directory, printed). With `AI_GATEWAY_API_KEY` set it also runs one identity-flicker pass and one per-frame fix within a $2 cap. Run it with `pnpm test:real`; it skips without the sheet.
