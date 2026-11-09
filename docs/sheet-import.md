# Sheet import and sheet generation

Animation starts as a whole contact sheet (owner decision, 2026-11-07). A model can generate a whole cycle as one sheet, and that keeps the character's identity consistent across frames. The import path turns a raw sheet into game-ready strips. The sheet can come from Assetforge's own sheet generation, ChatGPT or any other tool, or hand work. Per-frame reference edits are the fallback for fixing a single frame.

## The commands

```sh
# A sheet made elsewhere: slice, clean, and stage a grouping proposal.
pnpm assetforge import --sheet jimothy-sprite-sheet.png --profile profile.json --bible bible.json \
  --asset jimothy --tool "ChatGPT image generation" \
  --digital-source-type trainedAlgorithmicMedia --hints idle,walk-right,walk-left,crouch-hop,look,sit-groom

# Or have the model draw the cycle as one sheet (spec: assetId, animationFamily, frames.count).
pnpm assetforge generate-sheet --spec stevie-walk.json --bible bible.json --profile profile.json

# After reviewing and confirming grouping.json:
pnpm assetforge write-families --import .assetforge/imports/<import> --target ../clockgrove
```

## What each step does

1. **Slice.** The background is the median of the sheet's border. Every pixel farther from it than the tolerance is foreground (on a sheet with real alpha, alpha below 128 also counts as background). Figures are connected components. A grid is detected from the figures' centres: equal columns and rows, one figure per cell. `--grid <columns>` sets the grid; `--components` skips grid detection. Without a clean grid, each figure is located on its own and numbered in reading order. In a cell, the largest component is the figure. Small components inside its box are kept as detached parts; every other component (number labels, specks, a neighbour's tail) is dropped. Gutters and background never enter a frame.
2. **Remove the background**, following the target's style profile (below). Slicing's colour tolerance also catches the figure's own pale parts (a white blaze, brows, a muzzle or pale tail rings on a pale sheet), so those are given back first: only the flat background colour (within the spread of the cell's border, at least 8) and the pixels within 3 px of it are background. Flat background counts where it reaches the crop's border, and in an enclosed gap (a space between an arm and the body) that is mostly background and shows it: a flat core, four or more flat pixels, or flat pixels among blends of the background with the figure around it. Any other enclosed run is a marking and stays opaque; the matte step records how many pixels it gave back as `markingPixels`. The figure's interior stays opaque. In a thin band at its outer edge, and on pale fur strands just outside it, each pixel is unmixed from the background against the nearby figure colour that explains it best, which gives soft 8-bit alpha that keeps fur edges. The colour is that figure colour plus the pixel's own detail scaled by its alpha, never divided by alpha, so faint pixels carry the fur's colour and no tint or fringe from the removed background; a transparent pixel carries no colour. A binary profile then thresholds alpha, and a palette profile snaps colours. Labels, specks and neighbouring figures found while slicing, and a 2 px fringe around them, are made fully transparent even where they touch the band. Every frame is checked for halos (visible edge pixels that are the flat background colour) and for leftover background (opaque interior pixels of that colour), each under the same 0.5% limit (of edge pixels and of visible pixels). A frame that fails is reported and is refused at write time.
3. **Register.** Each frame's feet baseline (the lowest row at alpha 128 or more) and its alpha-weighted centre of mass go to the anchor, which defaults to the bottom centre of the target's frame. Within a family, each frame's scale is normalised to the family's median √(opaque area), clamped to ×0.8–1.25, so a sheet whose figure changes size from cell to cell comes out even. One common scale fits every written family into the target's frame size; it is fitted on the import's first write, stored in `import.json` as `scale`, and reused by every later write so all families of the asset stay one size. Pixel-art profiles resample nearest-neighbour; every other profile filters with premultiplied alpha.
4. **Measure jitter.** On each registered frame, jitter is the largest distance, in px, of the baseline or the centre of mass from the anchor. A family over the bound (default 1 px, `--jitter-bound`) is refused, and nothing is written.
5. **Propose a grouping.** A vision model sees a numbered contact sheet of the cleaned, registered frames (`contact.png`) and the subject's references. It proposes families, frame order, mirror pairs and a reason for each. The proposal is saved as `grouping.json` with `"status": "proposed"`.
6. **The author confirms.** Edit `grouping.json`: rename, regroup and reorder families, drop frames or whole families, and decide mirroring. A family is either `frames` (in play order; a frame may repeat for a hold) or `mirrorOf` another family, which is that family's frames flipped horizontally. Set `"status": "confirmed"`. `write-families` refuses any other status. Assetforge never confirms a grouping itself.
7. **Write.** One strip, manifest and provenance file per family, in the target's layout, with the review field at the profile's pending value. The target's validator runs on each one. `preview.html` in the import directory loops every written strip at the profile's frame duration and shows its jitter. Each family is also checked against its motion template and by loop and continuity QA, and gets an onion-skin sheet (`preview/<family>.onion.png`) and a looping animated WebP (`preview/<family>.webp`); see [animation.md](animation.md).

```json
{
  "status": "confirmed",
  "families": [
    { "name": "idle", "frames": [1, 2, 3, 4, 5, 6], "reason": "standing, breathing" },
    {
      "name": "walk-right",
      "frames": [7, 8, 9, 10, 11, 12, 13, 14],
      "reason": "a right walk cycle"
    },
    { "name": "walk-left", "mirrorOf": "walk-right", "reason": "the right walk, mirrored" }
  ],
  "unassigned": []
}
```

The import runs on the media transformation core ([transform.md](transform.md)). Importing is the recipe `slice → matte`, the contact sheet is `register → apply-style`, and writing is `flip` (for mirrored families) `→ register → apply-style → join`. `import.json` and each strip's provenance list these steps under `steps`.

## Style profile

The target profile's optional `style` decides post-processing. Each world declares its own (clockgrove/clockgrove#61); nothing assumes one style.

| Field                   | Values                                          | Default                                |
| ----------------------- | ----------------------------------------------- | -------------------------------------- |
| `style.alpha.mode`      | `soft` (8-bit alpha) or `binary` (0 or 255)     | `soft`                                 |
| `style.alpha.threshold` | the opacity bounds count from, and binary's cut | 1 for soft, 128 for binary             |
| `style.color.rule`      | `full` (no quantization) or `palette`           | `full`                                 |
| `style.color.palette`   | `#rrggbb` colours for the palette rule          | the bible's palette                    |
| `style.edges`           | `antialiased` or `crisp` (nearest-neighbour)    | `crisp` for binary, else `antialiased` |

A painterly world declares `{ "alpha": { "mode": "soft" }, "color": { "rule": "full" } }`. A pixel-art world declares `{ "alpha": { "mode": "binary" }, "color": { "rule": "palette" }, "edges": "crisp" }`.

Only the import path follows the style profile so far. `stage` and `pick` keep the binary alpha and bible palette of the first loop.

## Provenance

A family's provenance record (`generator: "sheet-import"`) holds:

- the source sheet: path, SHA-256, media type, and the model or tool that made it;
- the model calls Assetforge made: the sheet generation, if any, and the grouping proposal, with their prompts, request IDs, times and costs;
- the identity score of the contact sheet against the character's identity lock, when `--lock-bible` was given and the character has a lock (`identity`; see [generation-knobs.md](generation-knobs.md#identity-lock-scoring)). In enforce mode a sheet below the threshold is still imported, so the person sees it and why, but `write-families` refuses it;
- the parameters: style, frames, mirroring, the family's reason, the common scale and the measured jitter;
- `steps`: the transformation steps from the sheet to the strip, each with its parameters, engine and version, and input and output pixel hashes;
- one entry per strip frame: its frame number, sheet hash, cell, tool and every transform applied (`crop`, `strip-labels`, `matte`, `binarize` and `quantize` where the style asks, `mirror`, `normalize-scale`, `scale`, `place`).

For an imported sheet, the prompt field says that the tool's own prompt is not recorded. Manifest templates can read `{{output.jitterPx}}`, and `{{profile.style}}` for the style. `{{output.palette}}` is set only under a palette rule, so a full-colour template reads it as `{{output.palette?}}`.

Written sheet images and strips carry the [Digital Source Type disclosure](transform.md#digital-source-type-disclosure) in provenance and, when known, PNG XMP, with a metadata-writing step. For an external sheet, an embedded disclosure is preserved. Untagged sheets remain `undeclared` in provenance and receive no IPTC Digital Source Type value in XMP; Assetforge never guesses that they are human-made. Local import, staging and previews still work, but publication or export into a target, handoff or package refuses undeclared assets with a message naming `--digital-source-type`.

Use `import --digital-source-type trainedAlgorithmicMedia` for an untagged model-generated sheet such as a ChatGPT export, or `--digital-source-type compositeWithTrainedAlgorithmicMedia` for human work edited with a model. The flag accepts IPTC vocabulary codes or their full HTTP URIs, including `digitalCreation` for explicitly declared human digital creation. Assetforge validates the declaration and records who declared it in provenance. A free-text `--tool` label alone does not establish origin. Assetforge's own `generate-sheet` calls establish the generated source type automatically. Slicing, matting, registration and mirroring are deterministic processing and do not erase known lineage. Bounds and pixel hashes use decoded RGBA; file SHA-256 covers the final PNG, including any embedded metadata. The target profile's validator sees those final bytes.

## Cost

`generate-sheet` makes one `sheet` call (default `openai/gpt-image-2` at 1536x1024, estimated at $0.30) and one `vision` call for the grouping ($0.02). Both are reserved against the cap (default $5) before either is made. `import` makes the one grouping call, unless `--no-propose` is given. With `--lock-bible` and a locked character, either command adds one `identity` decision call (estimated at $0.001), reserved with the rest. That call is made in the default shadow mode too, so `import --no-propose --lock-bible` on a locked character needs a gateway key; add `--identity-mode off` to import it without one.

## The real Jimothy sheet

The owner's sheet is never committed here. To run the opt-in example, point `JIMOTHY_SHEET` at a local copy of Clockgrove's `docs/design/reference/jimothy-sprite-sheet.png` (Jimothy, the short-spine raccoon) and run `pnpm test:real`. It checks that the sheet slices into 57 clean frames. With `AI_GATEWAY_API_KEY` set, it also asks for a grouping proposal.
