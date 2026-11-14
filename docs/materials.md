# Relightable materials

`assetgrove materials` derives materials from a painted albedo, stages native-resolution renditions, runs the target's renderer, and sends flat and lit images to vision QA. It never approves an asset. The optional `style.materials` profile section chooses channels. When `materials` runs without that section, it defaults to all five standard channels and 1×/2× renditions; ordinary generation commands do not start materials implicitly.

```sh
assetgrove materials --albedo painted.png --spec asset.json --profile target.json \
  --derivation derivation.json --out .assetgrove/materials/asset --cap 2 --json
```

Albedo generation requests use a neutral key light without baked directional shadows, highlights or emissive glow. The materials command consumes that albedo; it does not remove existing baked lighting. Derivation and lit QA records preserve provider calls and costs. Model keys come from the environment; `--provider-script` provides offline scripted calls for tests, and `--routes` selects model routes. Real models are opt-in.

## World profile

The profile's `style.materials` object chooses channels, scales and target commands:

```json
{
  "channels": ["height", "normal", "emissive", "roughness", "wind"],
  "scales": [1, 2],
  "flickerBound": 0.03,
  "lightRig": {
    "dusk-rain": { "direction": [0.5, -0.5, 1], "intensity": 0.4 },
    "night": { "direction": [0, 0, 1], "intensity": 0.1 }
  },
  "compression": {
    "format": "ktx2",
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

Profile data is schema validated before execution. Omitted `channels` defaults to `normal`, `height`, `emissive`, `roughness`, `wind`; list only desired channels to switch others off, or use `[]` for albedo alone. Omitted `scales` defaults to `[1, 2]` and `flickerBound` to `0.03`. Unknown fields, duplicate channels/scales, malformed commands and invalid ranges are rejected. `lightRig` is a JSON object owned by the target renderer, preserved as data in the material report. The test profile declares a synthetic rig as an explicit stand-in.

Channels may declare an encoding, for example `"encoding": { "height": { "encoding": "unorm8", "range": [0, 1] } }`. The only supported storage encoding is `unorm8`; a narrower normalized range is enforced. `flickerBound` may instead be an object giving a bound for each requested channel.

The target implements its own compression and preview tools. Commands are argv arrays, run without a shell with a finite timeout; the executable must be installed. Relative command resources resolve from the profile's directory. Compression receives one PNG and must write GPU-compressed [KTX2/Basis](https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html), not a renamed PNG. Container checks cover dimensions, compressed format and indexed payload bounds; the target encoder remains responsible for codec correctness. `compression.format` is `ktx2` (default) or `basis`; both request Basis/GPU data in a KTX2 container. Omit `compression` only for a world that does not request GPU compression. The preview command receives the material report path and must write a PNG render for each `{{scene}}`: `dusk-rain` and `night`. It uses the world's own renderer and light rig. The QA input includes flat albedo and both renders, and the report provides paths for side-by-side author review.

Scales include 1× and 2×; add 4× when the world needs it. The painted albedo and every supplied map must contain sufficient native pixels for the highest requested scale on the complete horizontal frame grid. For example, two 32×32 frames requested at 2× need a native 128×64 strip. Assetgrove downsamples each frame separately; it refuses unsupported scales instead of silently enlarging a source. No implicit upscaler is used, and provenance records that fact.

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

Extraction takes a declared component (`red`, `alpha` or `luminance`) of a painted or externally estimated map; it does not infer geometric height from albedo brightness. A source may instead declare `model-assisted-painting` and a version, using a configured `material-<channel>` route through the budgeted gateway. The route and call record identify the actual model. Height-derived normals require a derived height input. Their `strength` is per base-resolution pixel; derivation compensates for native scale so the same height field keeps consistent slopes. Each channel records its declared recipe method/version, input/output hashes and encoding. Built-in extraction and height-gradient normal derivation additionally record their implementation version, separate from the caller's recipe version.

Height/depth, emissive, roughness/wetness and wind/flow use scalar normalized 8-bit values, 0 through 255. Normal RGB encodes tangent-space XYZ in normalized signed coordinates, with positive Y; neutral normals are approximately `(128, 128, 255)`. Maps share albedo alpha, frame grid and bounds. Emissive coverage must lie within masks bearing names listed in the spec; unnamed emitters fail. A roughness value of 0 is smooth/wet and 255 is rough; a wind mask of 0 is static and 255 allows full motion.

## QA and provenance

Deterministic QA checks alignment, ranges and named emissive coverage. Temporal QA registers each frame pair using rounded albedo alpha-centroid translation, measures the maximum residual map RGB change against the world's `flickerBound`, records offending frames, and includes the last-to-first seam. Albedo color changes do not subtract from or hide material flicker. Empty frames and comparisons with no corresponding opaque pixels fail. This is a measured heuristic rather than optical-flow correspondence; the report exposes the measurements for review. Lit vision QA examines flat albedo plus dusk-in-rain and night target renders for incorrect lighting, inverted normals and misplaced glow. Failure rejects the material set with CLI exit 5; the diagnostic report remains available. Approval always stays human.

Synthetic geometry and scripted providers exercise derivation, QA and the CLI without model calls or committed media. Synthetic target command fixtures prove the subprocess contract; they do not prove the target game's renderer or a production GPU codec. Run the target's real tools and opt-in providers to assess their image quality.

Material outputs carry the [Digital Source Type disclosure](transform.md#digital-source-type-disclosure) in their provenance. PNG renditions and target preview PNGs embed the same known value in XMP; undeclared assets carry `undeclared` in provenance and no IPTC Digital Source Type value in XMP. Deterministic derivations preserve source lineage; model-assisted painting of human-made material inputs uses `compositeWithTrainedAlgorithmicMedia`. Generated-only inputs retain `trainedAlgorithmicMedia`. Untagged inputs remain `undeclared`; deterministic processing never establishes human origin. An explicit `--digital-source-type <code>` declaration is validated against the IPTC vocabulary and recorded with its declarant. Local staging and previews work for undeclared assets, but publication or export into a target, handoff or package refuses them with a message naming `--digital-source-type`. GPU-compressed KTX2 files retain the disclosure in their existing provenance sidecars. File hashes cover final encoded bytes including metadata; pixel hashes and bounds use decoded RGBA.

## Planning and CLI contract

`assetgrove materials ... --dry-run --json` validates the material profile and forecasts the required model-assisted derivations plus one lit vision QA call, including a height dependency for height-derived normals. It writes no files, calls no model or target command, and needs no provider key. The JSON `plan` records channels, scales, each model call, estimated USD, cap and whether the forecast fits. Target command costs are not model charges and are not included. A forecast over `--cap` exits 3.

The command never prompts. `--json` emits one JSON document. Exit codes follow the common CLI contract: 0 success, 1 internal failure, 2 invalid input, 3 cost cap refusal, 4 provider failure, 5 rejected QA, and 6 target validator rejection where applicable.

Material derivations, native renditions and encoding are registered transformation operations with parameter schemas and individual provenance steps. `materials` runs those operations as recipes; `assetgrove ops --json` exposes their schemas for reusable recipes. Target compression and preview commands execute argv arrays without a shell, under finite timeouts; provenance records their arguments, output and exit status. Synthetic analytic shapes and a declared synthetic light rig prove geometry and lit response. The production target renderer, GPU codec and real model judgement remain opt-in integration checks.
