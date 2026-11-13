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

1. **Base colour.** The model is rendered flat-lit (base colour only, no shading) from 7 views: front, side, the other side, back, three-quarter, the other three-quarter, and a high view of the back. Each view is edited by the `lookdev` route (`openai/gpt-image-2`) together with the subject's approved references, matching view first. The views are restyled in that order, and each view after the first starts from a render of the model carrying what the earlier views painted (projected as below), so it extends their markings instead of placing its own. The square-on views come first, so the diagonal views continue markings a square-on view already placed along the body. The prompt asks the model to:
   - keep the silhouette, pose and framing;
   - repaint only the surface colour, as evenly lit albedo;
   - keep the character's features (eyes, nose, mouth, and any ears, limbs or tail) exactly where the render has them, even where the model's proportions differ from the references, and draw no feature where the render shows none;
   - keep every identity marking, broad colour regions included, where the references have it relative to those features: in the same place, with the same shape, size, colour and contrast, and the same number of repeats, neither softened nor added;
   - where a part alternates bands of two colours, give each band the width the references give it against its neighbours, and end the part in the references' colour;
   - paint nothing that stands off the surface, such as whiskers or stray hairs;
   - after the first view, keep a marking already painted where it shows, and continue it in the same colour.

   On Stevie (assetforge#122), each view restyled on its own put the side view's eye mask where the three-quarter view put pale coat, because the image model drew the profile's eye higher than the mesh's. Their average was a grey smudge.

   On Stevie (assetforge#129), the three-quarter view, restyled before the side, set the cheek's mask edge and the tail's rings; the side view redrew both elsewhere, and the blend handed the cheek to the three-quarter view's pale coat. Restyled after the square-on views, the diagonal views extend their rings and mask.

   Each edited view is registered onto its render: the figure's box is scaled and moved onto the render's. It is then projected back onto the model's own UVs:
   - every texel is baked to its rest-pose surface point and normal;
   - a texel takes a view's colour only where it is visible in that view, on the depth map, and faces the camera;
   - it never takes the edit's background: where the edit drew its figure narrower than the render (a leg drawn thinner), the background colour connected to the image's border, grown by one pixel, is left out. A pixel where the render itself is background-coloured is kept, since there the model's surface cannot be told from background;
   - each view is weighted by how squarely it sees the texel (facing⁴). Where the views agree, the texel takes their weighted mean. Where they disagree (the weighted spread of their colours, smoothed over 0.8% of the texture's edge, rises from 12 to 36 of 255), the facing power rises smoothly to 48. The view that sees the texel most squarely then takes it over, so a marking two views paint in slightly different places stays crisp instead of averaging to grey.

   Texels that no view sees squarely (the underside, a thin part's far edge) keep the source texture's detail, colour-matched to the projected result twice: across the whole texture, then locally. The local match adds the mean difference between the projected and the source colour over the seen texels around the texel in 3D, from the finest neighbourhood that holds enough of them (1.2% of the model's diagonal, doubling up to 6 times). So such a texel takes the colour its seen neighbours were painted, not the source's own marking there: on Stevie, the source's pale tail tip showed through the restyled dark one. The projection is made in 3D, so both sides of a UV seam receive the same colour. The islands are then dilated 8 px, so filtering never reads the background. The texture keeps the source's size, within the profile's `textureMaxPx`.

2. **Eyes and nose.** One `lookdev-locate` call (`google/gemini-3-flash`) reads a close-up front render and returns the pixel centre and radius of each eye and of the nose. Each point is cast onto the surface through the depth map, which gives a 3D sphere. The eye triangles are moved into their own material, `eyes`: the same base colour, roughness 0.05, no metal. Their mask is written too. Each eye gets a soft catch-light, offset toward the key light, painted into the `eyes` material's own emissive texture (emissive factor 1), never into the base colour. The target can keep it, or drop it and shade the eyes itself.
3. **Paw pads.** From the target's rig template: the downward-facing surface under each foot's ankle-to-toe span.
4. **Groom.** One `lookdev-groom` call per season reads the season's `traits` with the approved references. It returns fur length in millimetres and density (0 to 1) per region, and a tip tint where the coat's colour differs from the references. The regions are `face`, `cheek`, `head`, `neck`, `body`, `leg` and `tail`. They come from the rig template's joint roles and feet: the front of the head is face, and its lower sides are cheek. The maps are then written on the same UVs.
5. **Before and after.** The turntable views (front, three-quarter, side, back) and a close-up at the target's closest zoom are rendered before and after, once per season. After look-dev, the renders draw Assetforge's own shell fur, driven by that season's maps. `compare-<view>.png` puts, left to right:
   - the approved reference of that view (the front view for the close-up). A view the references do not name borrows the front view, and `lookdev-compare` says so;
   - the model before look-dev;
   - one column per season after look-dev.

   `unlit-before-<view>.png` and `unlit-after-<view>.png` show the base colour alone for the four turntable views, with no lighting or fur.

6. **Markings.** One `lookdev-markings` call (`google/gemini-3-flash`) per turntable view that has its own turnaround view. It reads that view, then the lit after render of each season. It names each identity marking that the bible's subject description names or the reference shows. For each marking, it gives in every image a box on the marking and a box on the neighbouring coat it contrasts with, as `[ymin, xmin, ymax, xmax]` on a 0 to 1000 scale. A box that mixes fractions with 0 to 1000 values is dropped. The route asks for low thinking (`providerOptions.google.thinkingConfig.thinkingLevel: "low"`): at the default level the call ran long enough to time out behind a metering relay. The measurement is deterministic: the CIELAB median of the figure's pixels in each box (see the `lookdev-markings` check).

**Preview lighting** (assetforge#122). Every before and after render, in every season, and the close-up share one lighting. It is relative to the camera, so each view is lit alike, as a turnaround is drawn. Assetforge's default is neutral: ambient 0.6, plus a key of 0.4 from above and to the left of the camera, with automatic exposure. The exposure is one number for the whole run. It brings the source model's mean lit brightness over the four turntable views to its unlit (albedo) brightness. It depends on the source model alone, so before and after share it. Highlights are not clipped: above 0.8 of full scale, values roll off smoothly toward white, so a pale marking in the key light keeps its tone. A target may declare its own `previewLighting` (see Contract). `parameters.lookdev.lighting` records the lighting, the exposure, and each season's lit-to-unlit figure brightness per view.

**The fur preview** draws `shells` offset copies of the surface (16 by default). Each copy is alpha-blended over what is beneath it, at the strands' expected coverage at that height. Strands thin toward the tips, and smooth clumps vary their length. No pixel makes a hit-or-miss choice per strand, so the coat stays soft and free of speckle at any zoom. It is a preview of what the maps drive, not the target's fur material.

## Checks

All of these are recorded as reasons before the person sees the result. A failing check filters the candidate.

| Check                                    | Passes when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookdev-albedo-coverage`                | At least 50% of the texels take colour from the restyled views.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `lookdev-seams`                          | The mean colour difference across UV seam edges (mesh edges welded by position whose UVs differ) is at most 8 (0–255), or at most 1.25 times the source texture's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `groom-<season>-masks` (`groom-masks`)   | Length is zero on every eye, nose and paw-pad texel and on no other texel, and each of the three masks holds texels. The reason gives each mask's count and names an empty mask and why it is empty.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `groom-<season>-render` (`groom-render`) | Shell fur driven by the season's maps changes more than 1% of a turntable view's pixels. The fur adds at most 0.5% speckle in each turntable view and the close-up. Speckle is the share of the figure's pixels whose luminance is more than 24 from their 3×3 median, fur render minus bare render.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lookdev-markings`                       | No identity marking drifts from the matching turnaround view, in any season's lit after render. A marking drifts when its colour differs by ΔE76 > 20, or when its contrast flips or keeps under half of the turnaround's. Contrast is the marking's L\* against the neighbouring coat when the turnaround's is 8 L\* or more. Otherwise it is the banding inside the marking's own box (80th minus 20th percentile of L\*), when the turnaround's is 8 L\* or more, so a ringed or banded marking whose median matches its neighbour is still held to its bands. Otherwise contrast is reported as not measurable and only the colour is held. A marking the turnaround shows and a render does not (no box, or no figure in its box) drifts. A view whose reply holds no JSON fails the check as unreadable. The reason gives each marking per view and season (ΔE, and contrast or banding reference → render). It names every drifting marking, and every view or marking not measured, and why: a view the references do not name, a marking not located on the reference. |
| `eyes-catch-light`                       | Eyes were located, their triangles are in the `eyes` material, and the close-up at the closest zoom shows a highlight in every located eye (peak luminance at least 200, and 60 over the eye's mean).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `lookdev-compare`                        | Every compare image has a turnaround column. A view whose own reference is missing, and so shows the front view, is named in the reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `gltf-validator`, `budget-*`             | As for every 3D candidate. The groom maps are resolved as external files. Their size counts toward `textureMaxPx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `identity-lock`                          | The identity lock scores the front and three-quarter renders after look-dev (first season) against the approved references, in the profile's identity mode, as for wave 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Contract

The field names below are shared with clockgrove/raccoon-world#39 and Clockgrove's fur material. Names may be added, but none may be renamed without recording it on both issues.

**Profile**

```json
"model3d": {
  "groom": { "maps": ["length", "direction", "density"], "sizePx": 2048, "seasons": ["summer", "winter"] },
  "lookdev": {
    "capUsd": 3,
    "closestZoom": { "screenHeightPx": 1440, "characterScreenFraction": 0.3333 },
    "previewLighting": { "ambient": 0.6, "key": 0.4, "keyDirection": [-0.4, 0.5, 0.75], "exposure": "auto" }
  }
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
  - `previewLighting` (added by assetforge#122) is the lighting of the before and after renders, with each field optional. The shown values are the defaults. `keyDirection` is in camera space: x right, y up, z toward the camera. `exposure` is a number, or `"auto"`.

**Template outputs**

| Field                           | Value                                                                                                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `output.groom.<season>.<map>`   | `{ path, sha256 }` of each map, keyed by season then map when `seasons` is declared (`output.groom.<map>` without). `length` also has `maxLengthM`.                                                            |
| `output.textures.baseColor`     | `{ path, sha256 }` of the new base colour PNG. The same image is embedded in the `.glb`, so the model stays self-contained.                                                                                    |
| `output.textures.tint.<season>` | `{ path, sha256 }` of an RGBA texture on the model's UVs. Its RGB multiplies the base colour, and its alpha weights the tint toward the fur tips. Present only for seasons whose colour differs from the base. |
| `output.eyes`                   | `{ material, path, sha256 }`: the eye material's name (`eyes`) and its mask (white on the eyes). The catch-light is that material's embedded emissive texture.                                                 |

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

Before the first call, the whole forecast is checked against the cap and against the cross-run limits (daily and work item; assetforge#74). Each call is reserved before it is made. The default routes forecast $1.89: 7 × $0.25 + $0.02 + 2 × $0.02 + 4 × $0.02 + $0.001. The four markings calls are an upper bound: only views with their own turnaround view make one. `--dry-run` prints the forecast and what is left under each limit.

Tests use the scripted provider in `test/fixtures/lookdev-script.ts`.
