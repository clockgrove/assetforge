# Character look-dev

Look-dev (wave 1 of [PLAN.md](PLAN.md); assetforge#82) gives a picked, rigged 3D character three things:

- a base colour in the target's character look, on the model's own UVs, in place of the provider's texture;
- fur groom maps the target's fur material reads, one groom per season the target declares;
- eyes that catch light.

It checks each of these, then writes before-and-after renders beside the approved turnaround for the person who approves. It never regenerates the mesh, the UVs or the rig, and it never approves anything.

```sh
assetforge look-dev --model stevie.glb --provenance stevie.glb.provenance.json \
  --spec art/stevie/character-3d/spec.json --bible art/style-bible.json \
  --profile art/target-profile-3d.json --dry-run
assetforge look-dev ... # AI_GATEWAY_API_KEY
assetforge pick --run .assetforge/runs/<run> --candidate c1 --target ../raccoon-world
```

`look-dev` stages a one-candidate run (`c1`), like `rig`, and `pick` hands it off. It exits 5 when the result fails a check. The renders are still written, so the person can see why.

## The look is the target's

Nothing in the code or the prompts names a style, a look or a species. The restyle prompt is composed from:

- the bible's subject description;
- the notes of the spec's `look` (for Raccoon World, `character`), with the shared notes;
- the subject's approved references for that look.

The groom prompt reads the season's `traits` from the profile, as given.

## How it works

1. **Base colour.** The model is rendered flat-lit (base colour only, no shading) from 7 views: front, three-quarter, side, back, the other side, the other three-quarter, and a high view of the back. Each view is edited by the `lookdev` route (`openai/gpt-image-2`) together with the subject's approved references, matching view first. The prompt asks the model to:
   - keep the silhouette, pose and framing;
   - repaint only the surface colour, as evenly lit albedo;
   - keep every identity marking where the references have it.

   Each edited view is registered onto its render: the figure's box is scaled and moved onto the render's. It is then projected back onto the model's own UVs:
   - every texel is baked to its rest-pose surface point and normal;
   - a texel takes a view's colour only where it is visible in that view, on the depth map, and faces the camera;
   - each view is weighted by how squarely it sees the texel.

   Texels that no view sees (the underside) keep the source texture, colour-matched to the projected result. The projection is made in 3D, so both sides of a UV seam receive the same colour. The islands are then dilated 8 px, so filtering never reads the background. The texture keeps the source's size, within the profile's `textureMaxPx`.

2. **Eyes and nose.** One `lookdev-locate` call (`google/gemini-3-flash`) reads a close-up front render and returns the pixel centre and radius of each eye and of the nose. Each point is cast onto the surface through the depth map, which gives a 3D sphere. The eye triangles are moved into their own material, `eyes`: the same base colour, roughness 0.05, no metal. Their mask is written too.
3. **Paw pads.** From the target's rig template: the downward-facing surface under each foot's ankle-to-toe span.
4. **Groom.** One `lookdev-groom` call per season reads the season's `traits` with the approved references. It returns fur length in millimetres and density (0 to 1) per region, and a tip tint where the coat's colour differs from the references. The regions are `face`, `cheek`, `head`, `neck`, `body`, `leg` and `tail`. They come from the rig template's joint roles and feet: the front of the head is face, and its lower sides are cheek. The maps are then written on the same UVs.
5. **Before and after.** The turntable views (front, three-quarter, side, back) and a close-up at the target's closest zoom are rendered before and after, once per season. After look-dev, the renders draw Assetforge's own shell fur, driven by that season's maps. `compare-<view>.png` puts, left to right:
   - the approved reference of that view (the front view for the close-up);
   - the model before look-dev;
   - one column per season after look-dev.

## Checks

All of these are recorded as reasons before the person sees the result. A failing check filters the candidate.

| Check                                    | Passes when                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lookdev-albedo-coverage`                | At least 50% of the texels take colour from the restyled views.                                                                                                                            |
| `lookdev-seams`                          | The mean colour difference across UV seam edges (mesh edges welded by position whose UVs differ) is at most 8 (0–255), or at most 1.25 times the source texture's.                         |
| `groom-<season>-masks` (`groom-masks`)   | Length is zero on every eye, nose and paw-pad texel and on no other texel, and there are bare texels to check.                                                                             |
| `groom-<season>-render` (`groom-render`) | Shell fur driven by the season's maps changes more than 1% of a turntable view's pixels.                                                                                                   |
| `eyes-catch-light`                       | Eyes were located, their triangles are in the `eyes` material, and the close-up at the closest zoom shows a highlight in an eye (peak luminance at least 200, and 60 over the eye's mean). |
| `gltf-validator`, `budget-*`             | As for every 3D candidate. The groom maps are resolved as external files. Their size counts toward `textureMaxPx`.                                                                         |
| `identity-lock`                          | The identity lock scores the front and three-quarter renders after look-dev (first season) against the approved references, in the profile's identity mode, as for wave 0.                 |

## Contract

The field names below are shared with clockgrove/raccoon-world#39 and Clockgrove's fur material. Names may be added, but none may be renamed without recording it on both issues.

**Profile**

```json
"model3d": {
  "groom": { "maps": ["length", "direction", "density"], "sizePx": 2048, "seasons": ["summer", "winter"] },
  "lookdev": { "capUsd": 3, "closestZoom": { "screenHeightPx": 1440, "characterScreenFraction": 0.3333 } }
}
```

- `groom` fields:
  - Every field is optional.
  - `maps` defaults to the three maps.
  - `sizePx` defaults to the base colour's size.
  - Without `seasons`, there is one groom, with its maps keyed by map name.
  - `traits` (each season's look in words) and `calendar` are the target's. `traits` is read as given; `calendar` is carried, not read.
- `lookdev` (added) fields:
  - `capUsd` is the look-dev cap for one character, default $3. `--cap` overrides it.
  - `closestZoom` is the target's closest zoom, used for the close-up check render. The default is the character at a third of a 1440 px screen height, desktop (Kirk, 2026-11-10).

**Template outputs**

| Field                           | Value                                                                                                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `output.groom.<season>.<map>`   | `{ path, sha256 }` of each map, keyed by season then map when `seasons` is declared (`output.groom.<map>` without). `length` also has `maxLengthM`.                                                            |
| `output.textures.baseColor`     | `{ path, sha256 }` of the new base colour PNG. The same image is embedded in the `.glb`, so the model stays self-contained.                                                                                    |
| `output.textures.tint.<season>` | `{ path, sha256 }` of an RGBA texture on the model's UVs. Its RGB multiplies the base colour, and its alpha weights the tint toward the fur tips. Present only for seasons whose colour differs from the base. |
| `output.eyes`                   | `{ material, path, sha256 }`: the eye material's name (`eyes`) and its mask (white on the eyes).                                                                                                               |

The usual 3D outputs (`output.triangles`, `output.clips`, `output.bounds`, `output.rig` and the rest) are carried over from the source model, measured on the new file.

**Map encodings** (also in the `.glb`'s `asset.extras.lookdev.groom.encoding`):

- `length`: grey, where 0 is no fur and 255 is `maxLengthM`, the season's longest region length.
- `direction`: the rest-pose, model-space comb direction, tangent to the surface, stored as `rgb = d × 0.5 + 0.5`. The fur combs along the body's flow: from the snout back over the head and body, and down the legs and tail.
- `density`: grey, as a fraction (0 to 1) of the fur material's strand density.

**In the glTF**, the groom maps, tints and the eye mask are external images (`images[].uri`) next to the `.glb`, never embedded. A target can then load them only on tiers that draw fur. `asset.extras.lookdev.images` maps each output field to its image index and `uri`.

**Hand-off.** `pick` writes the `.glb`, then each side file next to it as `<assetId>.<field>.png` (for example `stevie.groom.winter.length.png`), through the profile's `layout`. The side files' `{ path, sha256 }` are set in `output.*` before the manifest renders, and then the target's validator runs. Reading the maps in the target's fur material is the target's work. Clockgrove's shell fur is clockgrove/clockgrove#242.

## Provenance and spend

The run keeps the source model's provenance and adds the following:

- every look-dev call, with its prompt, references, request ID, cost and output grant;
- `parameters.lookdev`, which holds:
  - `sourceModel` (the file name only) and `sourceModelSha256`;
  - the views and the seasons' grooms;
  - the located eyes and nose, and the bare-texel counts;
  - the closest zoom, the coverage and the cost;
- a `lookdev` step, whose input is the source model's hash and whose output is the new model's hash;
- the combined `outputGrant` over every call, the source's included.

Before the first call, the whole forecast is checked against the cap and against the cross-run limits (daily and work item; assetforge#74). Each call is reserved before it is made. The default routes forecast $1.81: 7 × $0.25 + $0.02 + 2 × $0.02 + $0.001. `--dry-run` prints the forecast and what is left under each limit.

Tests use the scripted provider in `test/fixtures/lookdev-script.ts`.
