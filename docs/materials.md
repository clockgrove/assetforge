# Relightable materials

`assetforge materials` derives materials from a painted albedo, stages native-resolution renditions, runs the target's renderer, and sends flat and lit images to vision QA. It never approves an asset. Existing worlds opt in with `style.materials`; worlds choose their channels.

```sh
assetforge materials --albedo painted.png --spec asset.json --profile target.json \
  --derivation derivation.json --out .assetforge/materials/asset --cap 2 --json
```

Albedo generation requests use a neutral key light without baked directional shadows, highlights or emissive glow. The materials command consumes that albedo; it does not remove existing baked lighting. Derivation and lit QA records preserve provider calls and costs. Model keys come from the environment; `--provider-script` provides offline scripted calls for tests, and `--routes` selects model routes. Real models are opt-in.

## World profile

The profile's `style.materials` object chooses channels, scales and target commands:

```json
{
  "channels": ["height", "normal", "emissive", "roughness", "wind"],
  "scales": [1, 2],
  "flickerBound": 0.03,
  "compression": {
    "version": "target-encoder-1",
    "command": ["target-encode", "--input", "{{input}}", "--output", "{{output}}"]
  },
  "preview": {
    "version": "target-renderer-1",
    "command": [
      "target-preview",
      "--materials",
      "{{materials}}",
      "--scene",
      "{{scene}}",
      "--output",
      "{{output}}"
    ]
  }
}
```

Channels may declare an encoding, for example `"encoding": { "height": { "encoding": "unorm8", "range": [0, 1] } }`. The only supported storage encoding is `unorm8`; a narrower normalized range is enforced. `flickerBound` may instead be an object giving a bound for each requested channel.

The target implements its own compression and preview tools. Commands are argv arrays, run without a shell with a finite timeout; the executable must be installed. Relative command resources resolve from the profile's directory. Compression receives one PNG and must write GPU-compressed KTX2/Basis, not a renamed PNG. Omit `compression` only for a world that does not request GPU compression. The preview command receives the material report path and must write a PNG render for each `{{scene}}`: `dusk-rain` and `night`. It uses the world's own renderer and light rig. The QA input includes flat albedo and both renders, and the report provides paths for side-by-side author review.

Scales include 1× and 2×; add 4× when the world needs it. The painted albedo and every supplied map must contain sufficient native pixels for the highest requested scale on the complete horizontal frame grid. For example, two 32×32 frames requested at 2× need a native 128×64 strip. Assetforge downsamples each frame separately; it refuses unsupported scales instead of silently enlarging a source. No implicit upscaler is used, and provenance records that fact.

## Per-asset derivation

The spec names allowed light emitters as `fields.lightSources`, for example `["windows", "lantern"]`. The derivation file supplies source maps and emitter masks, with paths relative to that file:

```json
{
  "maps": {
    "height": {
      "method": "mask-extraction",
      "version": "painted-depth-1",
      "path": "depth.png",
      "component": "red"
    },
    "normal": {
      "method": "height-derived-normal",
      "version": "finite-difference-1",
      "strength": 1
    },
    "emissive": {
      "method": "mask-extraction",
      "version": "painted-glow-1",
      "path": "glow.png",
      "component": "red"
    },
    "roughness": {
      "method": "mask-extraction",
      "version": "painted-roughness-1",
      "path": "roughness.png",
      "component": "red"
    },
    "wind": {
      "method": "mask-extraction",
      "version": "painted-flow-1",
      "path": "wind.png",
      "component": "red"
    }
  },
  "lightSources": [
    { "name": "windows", "mask": "windows-mask.png" },
    { "name": "lantern", "mask": "lantern-mask.png" }
  ]
}
```

Extraction takes a declared component (`red`, `alpha` or `luminance`) of a painted or externally estimated map; it does not infer geometric height from albedo brightness. A source may instead declare `model-assisted-painting` and a version, using a configured `material-<channel>` route through the budgeted gateway. The route and call record identify the actual model. Height-derived normals require a derived height input. Each channel records its declared recipe method/version, input/output hashes and encoding. Built-in extraction and height-gradient normal derivation additionally record their implementation version, separate from the caller's recipe version.

Height/depth, emissive, roughness/wetness and wind/flow use scalar normalized 8-bit values, 0 through 255. Normal RGB encodes tangent-space XYZ in normalized signed coordinates, with positive Y; neutral normals are approximately `(128, 128, 255)`. Maps share albedo alpha, frame grid and bounds. Emissive coverage must lie within masks bearing names listed in the spec; unnamed emitters fail. A roughness value of 0 is smooth/wet and 255 is rough; a wind mask of 0 is static and 255 allows full motion.

## QA and provenance

Deterministic QA checks alignment, ranges and named emissive coverage. Temporal QA measures per-frame channel residual change beyond the albedo's pose change against the world's `flickerBound`, records offending frames, and rejects excessive change. This is a measured heuristic rather than optical-flow correspondence; the report exposes the measurements for review. Lit vision QA examines flat albedo plus dusk-in-rain and night target renders for incorrect lighting, inverted normals and misplaced glow. Failure rejects the material set with CLI exit 5; the diagnostic report remains available. Approval always stays human.

Synthetic geometry and scripted providers exercise derivation, QA and the CLI without model calls or committed media. Synthetic target command fixtures prove the subprocess contract; they do not prove the target game's renderer or a production GPU codec. Run the target's real tools and opt-in providers to assess their image quality.
