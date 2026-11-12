# Assetforge PRD

Status: draft 1 (2026-11-07). Owner: Kirk Marple. First adopter: Clockgrove's Raccoon World.
The implementation plan, split into waves that drive Objectives, follows from this document and is kept separately.

## 1. Why

A living game world needs a lot of art and sound, and it keeps needing more.

Clockgrove's Raccoon World needs:
- raccoons in many body, age and size variants, each with portraits and expressions;
- about fifteen animation families per character;
- props for the den, porch, trees, fences and garden;
- weather, time-of-day and wetness effects;
- icon families;
- ambient audio loops;
- and later, world packs written by creators (Wave 7), and renderer-neutral 3D (architecture §20).

Image, video, audio and 3D models can produce the raw material. Raw model output is not a game asset, though. It has the wrong size and background, drifting identity and style, no provenance and no review. Today a person closes that gap by hand, one asset at a time.

Assetforge closes it as a tool. A game declares what it needs as data. Assetforge turns the request into candidates that already meet the game's spec, shows a person only the ones worth looking at, and hands the pick to the game's own pipeline with complete provenance.

**North star:** a game author files a request for a set of assets, comes back to a short list of in-spec candidates shown in the game's own scene, picks, and the picks land as pending assets the game's validator accepts. Spend stays within the declared cap, and every file is traceable.

## 2. Principles

1. **Generic core, game as data.** Anything specific to one game reaches Assetforge as a *target profile* and a *style bible*: data, never code. Reason: Clockgrove is the first adopter, not the only one.
2. **Spec first.** A request is built from a typed asset spec, not typed freehand. Reason: output that matches the spec costs less to review than output that only looks right.
3. **Humans approve.** Assetforge filters, ranks and explains. It never marks anything approved. Reason: the target's review is the quality and license gate, and it belongs to people.
4. **Provenance is part of the asset.** Every output records its model, route, prompt, parameters, references, seed where supported, request ID, time, cost and the provider terms. Reason: licensing, reproducibility and trust.
5. **Bounded spend.** Every run reserves against a cap before it calls a provider, and refuses a run that would go over. Reason: generation is cheap per call and expensive in aggregate.
6. **Format-agnostic.** Media types are declared per output. The code never keeps a list of allowed formats, and `.gitattributes` decides what Git LFS stores. Reason: video, audio and 3D arrive later through new generators, not rewrites.
7. **Providers behind adapters.** One gateway adapter for models. Provider SDK types never leak past it. Reason: models change monthly.
8. **GitHub is the record.** Requests, candidates, picks and their history live in repositories and pull requests, not in a hosted service Assetforge would have to run. Reason: no platform to operate; review happens where code review already happens.
9. **Offline by default.** Tests use a scripted provider. Real-provider runs are opt-in and skip cleanly without a key.

## 3. Users and jobs

| User | Job |
| --- | --- |
| Game author / art director | Request an asset or a whole set; see in-spec candidates in context; pick; keep the world's look consistent over months. |
| Reviewer (the target's human gate) | Approve or reject picks in the target's own review, with the evidence beside each one. |
| Coding agent (for example a Factory worker) | Request assets inside a task and stage candidates for a human pick, without being able to approve them. |
| World-pack creator (later) | Produce a pack's assets under the world's style bible without being an artist. |
| Maintainer of another game | Adopt Assetforge with a new target profile and style bible, with no code changes. |

## 4. Concepts

- **Target profile.** The target game's contract, as data: manifest schema and file layout, the frame grid, and the world's **style profile**: alpha mode (binary or soft), colour rule (a fixed palette or full colour), edge rendering (crisp or antialiased) and size limits per asset role. Clockgrove's world packs each declare one (#61), and flat-cartoon and pixel-art packs are as valid as Raccoon World's. A bible can declare per-domain looks that a spec names (`look`), so characters and environments can differ: Raccoon World's characters are naturalistic, matching Stevie's approved turnaround, and its yard is lightly painterly (Kirk, 2026-11-11). Then naming, license value, the validator command, and the in-context preview command. A test in the target keeps it in step with the target's validator.
- **Style bible.** The world's visual (and later audio) constitution, as data in the target repository:
  - approved reference images: character sheets, turnarounds, props, a perspective sample;
  - the colour rule the style profile names: a colour script (key colours and value ranges per time of day) for a full-colour world, or the palette for a fixed-palette one;
  - the lighting key;
  - line and texture notes;
  - negative examples;
  - the mood words and the reference image. For Raccoon World: rendered storybook realism with a lightly painterly yard and naturalistic, high-quality characters (Stevie's approved turnaround), a high three-quarter isometric camera, soft fur, full colour, large environment pieces, warm lantern light against cool dusk rain (Clockgrove `docs/design/reference/raccoon-world-reference.png`).

  It has a version. Every output records the bible version it was made under.
- **Asset spec.** One requested asset: kind (sprite strip, still, portrait, icon, tile, effect, loop, model), identity, animation family, frame count and size, anchor and footprint, variants, and any per-asset references.
- **Request.** A spec, or a set of specs, plus a candidate count and a cost cap.
- **Candidate.** One generated, post-processed output, with its QA result and provenance.
- **Pick.** The candidate a person chose. Written into the target as `review.status: "pending"`.
- **Campaign.** A planned batch of requests (for example "Wave 8's complete reviewed asset set"), with a budget, progress and a resume point.
- **Asset lock.** A committed record of how each asset was produced (inputs, references, model route, seed, bible version), so it can be regenerated, audited or flagged as stale.

## 5. Capabilities

### 5.1 Generation loop (first release)

1. **Spec in.** Read the target profile, the style bible and the asset spec. Build model inputs from them: references as image inputs, constraints as structured prompt parts.
2. **Candidates.** Generate N candidates (default 4) within the per-run cap (default $5). Stills come from a text-and-reference image model. Animation frames come from a reference-edit model.
3. **Post-process to spec.** Everything here follows the target's style profile: background removed to the profile's alpha mode (soft edges that keep fur and foliage antialiasing, or binary alpha with crisp pixel edges), crop and scale to the frame grid at the role's size (nearest-neighbour for pixel art), colour kept to the profile's rule (within the colour script, or quantized to the palette), alignment to the anchor and pivot, and bounds computed the way the target computes them. All of it deterministic.
4. **Vision QA.** A vision model, plus deterministic checks, scores each candidate on four things. Failing candidates are never shown.
   - **Spec:** transparency, frame count and size, the profile's colour and alpha rules.
   - **Identity:** the same character as its references.
   - **Perspective:** matches the isometric sample.
   - **Style:** close to the bible.
5. **Pick.** The author sees the passing candidates beside the references, each with its QA reasons, and picks one or none.
6. **Hand-off.** The pick and its manifest are written into the target in the profile's format, with full provenance and `review.status: "pending"`. Git LFS stores the media. The target's validator must accept the output; Assetforge runs it before it reports success.

### 5.2 Animation that holds together

- **Sheet generation first (owner decision, 2026-11-07).** The model generates a whole cycle as one contact sheet, which keeps identity consistent across frames far better than frame-by-frame requests. An import path turns a sheet into a strip:
  - slices the frames;
  - removes the background to the style profile's alpha mode;
  - strips labels;
  - registers every frame on the feet baseline;
  - groups and orders frames into families, with vision-model proposals a person confirms.

  The same import takes sheets made elsewhere. Raccoon World's first one is the 57-frame sheet of Jimothy, the short-spine raccoon: Clockgrove `docs/design/reference/jimothy-sprite-sheet.png`.
- **Per-frame fixes.** A reference-guided edit of one frame, from an approved neighbour or key pose, repairs a single bad frame without regenerating the sheet.
- **Video later.** Video-to-frames is a third route, compared against sheets once it arrives.
- **Motion templates.** Per family (walk, idle, sniff, eat, play, shelter, sleep, groom, climb, converse and so on), a template gives the beats, timing and contact frames. A walk cycle loops and keeps its feet on the ground line.
- **Loop and continuity QA.** It checks that:
  - the last frame flows into the first;
  - there are no identity flickers between frames;
  - the anchor and footprint don't drift;
  - the silhouette varies the way the template says it should.

  It also renders an onion-skin sheet and a looping preview for the person picking.
- **Direction sets.** For isometric games, a direction set is generated as a family of related requests, sharing the character's identity reference.

### 5.3 Consistency engine (the differentiator)

A world's look is only as good as its weakest asset, so Assetforge treats consistency as data:
- **Identity lock.** Each character has an identity record: its approved references plus a vision-model fingerprint. Every candidate of that character is scored against it, and a candidate below the threshold is filtered out with the reason.
- **Style distance.** Every candidate gets a style score against the bible's references. The score is recorded, so the world's spread can be seen over time.
- **Drift report.** When the style bible changes version, the asset locks show which approved assets were made under an older bible. A campaign can regenerate them for review.
- **Colour and lighting audit.** A set-level check finds assets that break the style profile's colour rule or the lighting key (light direction, warmth, value range), even when each one passed alone.

### 5.4 In-context preview

An asset that looks right on a white background can look wrong in the yard. The target profile can declare a preview command, which renders a candidate in the game's own scene: for Clockgrove, its golden-scene renderer at night in the rain, next to Stevie. The pick screen shows each candidate in place. Assetforge only calls the command and never knows the game's renderer.

### 5.5 Material maps: lit 2.5D, 3D-ready

Owner decision (2026-11-07): the visual ceiling is lit 2.5D now and 3D-ready later. A target's renderer lights the scene with dynamic lights, shadows, colour grading, bloom, reflections, fog, wind and particles, at several quality tiers. A sprite lit for one moment fights all of that, so by default every asset ships as a material, not a picture. The colour (albedo) is generated under the style bible's neutral key light, and a standard set of maps comes with it, aligned to the same frame grid:
- **normal** and **height/depth**: shape for dynamic light, shadows and depth sorting, and the bridge to a later 3D renderer;
- **emissive** and **roughness/wetness**: window glow and lantern light, and how rain darkens and shines a surface;
- **wind/flow**: how foliage, fur and water move.

The target's style profile can turn any channel off, and it declares how each channel is encoded.

- **Derived, then checked.** Maps are derived from the albedo and its references. Where a model produces them, they are checked against the albedo, so an edge in the normal map matches an edge in the colour.
- **Temporal stability.** Across an animation's frames, the maps must not flicker. A bound on frame-to-frame change per channel is part of QA.
- **Lit-preview QA.** The pick screen shows each candidate lit by the target's own light rig at several moments (noon, dusk in rain, night under lantern light), using the in-context preview (§5.4).
- **Renditions.** Every asset is delivered at 1× and 2×, plus GPU-compressed textures (KTX2) when the target profile asks for them, so the game picks per quality tier.
- **Lights as data.** Assetforge reads the target's light rig as data, for preview only. The renderer that lights the game is the target's choice (Clockgrove decides by a bake-off, #67).

### 5.6 Sets and campaigns

- **Variant matrices.** One request expands into a grid: character × age × animation family, or prop × weather state. Shared references keep the grid consistent.
- **Campaigns.** A whole set (for example Wave 8 §10.2) is planned as a campaign, with a budget, an order (identities and sheets first, then frame fixes, then variants), progress, resume after interruption, and a final set-level audit.
- **Cost forecast.** A campaign shows its forecast cost before it starts, and its actual cost against that forecast as it runs.

### 5.7 Review where review already happens

- **CLI and local web picker** for an author at their desk.
- **GitHub-native picking.** As a GitHub Action, Assetforge opens a pull request in the target repository with the candidates. The PR comment holds a gallery: references, candidates, QA reasons and in-context renders. The author picks with a checkbox or a reply. Assetforge then commits the pick, removes the rejected candidates and leaves the PR for the target's human approval. No hosted service is involved.
- **Agent use.** Assetforge exposes a tool interface (a CLI with JSON output, plus an MCP server) so a coding agent can request assets inside a task. Agents can stage candidates and open the pick PR. They cannot pick or approve.

### 5.8 More media types, through new generators

Each of these arrives as a generator behind the same loop, with its own post-processing and QA, and no core changes:
- **Icons:** families with a shared grid, stroke and palette, and contrast and colour-blind-safety checks.
- **Portraits and expressions:** an identity-locked expression set per character.
- **Tiles and terrain:** seamless-edge checks and isometric tile footprints.
- **Effects:** rain, puddles, fog, light cones; alpha and loop checks.
- **Audio:**
  - ambient loops (rain at several intensities, birds, distant neighbourhood), with seamless loop points;
  - short cues;
  - loudness normalization and per-group levels.

  The target profile declares the sensory-safe defaults.
- **Video:** short loops for UI and effects, and video-to-frames for animation once frame consistency beats key-pose editing.
- **3D (later):** image-to-3D for props and characters as `.glb`, with turntable renders for QA and the pick, and polygon and texture budgets from the target profile. This follows the architecture's renderer-neutral presentation (§20).

### 5.9 Provenance, licensing and reproducibility

- Every output carries a provenance record:
  - the model and route;
  - the prompt and parameters;
  - the reference hashes;
  - the seed where supported;
  - the request ID, time and cost;
  - the version of the provider's terms;
  - the style bible's version.
- The license value comes from the target profile. Clockgrove: MIT, as its own work; owner decision, 2026-11-07.
- Every call records the provider's `outputGrant` from its route, and the provenance the combination over its calls (most restrictive wins). An output is declared under the target's licence only when the grant lets the target relabel it; an attribution licence the target lists in `acceptedLicenses` is declared as itself; anything else, and every non-commercial grant, is refused at hand-off (assetforge#47).
- The asset lock makes every approved asset auditable, and regenerable as far as the provider allows.
- Candidates are cached by content hash. Asking the same question twice does not pay twice.

### 5.10 Safety and policy

- **Prompt policy:**
  - no generation in the style of a named living artist;
  - no copyrighted characters;
  - no real people;
  - provider moderation results are recorded.
- **No private art in the public repository.** Test fixtures are synthetic. A game's style bible stays in the game's repository.
- **Keys come from the environment only.** The cost cap applies on every path, including agent use.

### 5.11 Media transformation

Owner direction (2026-11-07): transformation is a core layer of its own, not a side effect of generation. Every operation works the same on generated, imported and hand-made media, so an author can fix, convert or recombine an asset without regenerating it. Generators, the sheet import (§5.2) and hand-off all use this layer.

- **Images and frames.**
  - Slice a sheet into frames, or join frames into a strip or sheet.
  - Crop, trim to content, pad, scale (with the resampling the style profile names: smooth, or nearest-neighbour for pixel art), rotate and flip.
  - Remove a background, clean up alpha, and convert colour space.
  - Quantize to a palette (only when the profile declares one).
  - Register frames on a baseline or anchor.
  - Produce renditions (1×, 2×) and mipmaps.
- **Audio.**
  - Trim, split, merge and concatenate.
  - Fade and crossfade, and find or make seamless loop points.
  - Resample, change channels, and normalize loudness.
  - Cut a clip into cues.
- **Video.**
  - Trim, split and concatenate.
  - Extract frames (feeding the sheet import), or turn frames back into video.
  - Change frame rate, scale, crop, and loop.
- **3D (later).** Convert formats, decimate to a polygon budget, bake or resize textures, and render turntables.
- **Format conversion across all of these.** The input and output formats come from the request and the target profile. The code keeps no list of allowed formats (principle 6). Images: PNG, WebP, AVIF, JPEG, KTX2. Audio: WAV, OGG/Opus, MP3. Video: MP4, WebM, image sequences. 3D: glTF/GLB.

**Rules.**
- **Deterministic.** The same input bytes and parameters give the same output bytes, so outputs can be cached by content hash and regenerated from the asset lock.
- **Provenance travels.** Every operation appends its name, parameters, the tool version and the input hash to the output's provenance, so a chain from generated sheet to final strip is replayable.
- **Composable and non-destructive.** Operations chain into recipes, declared as data, which a target profile or style profile can name (Raccoon World: "import sheet, then soft alpha, then baseline registration"). Sources are never overwritten.
- **Engines behind adapters.** The image, audio and video engines (for example libvips or FFmpeg) sit behind one adapter each, like the model gateway, so an engine can be replaced without touching recipes.
- **The same surfaces.** Every operation is available on the CLI with JSON output, in the MCP tools for agents, and inside campaigns.

## 6. Raccoon World requirements (first adopter)

These requirements come from Clockgrove's pipeline (`packages/assets/docs/pipeline.md`), its Wave 4 and Wave 8 plans, and the architecture.

| Need | Source | Assetforge capability |
| --- | --- | --- |
| Sprite strips: `frames.count` frames side by side; RGBA; alpha, colour and size rules from the world pack's style profile (#61; Raccoon World: soft alpha, full colour); bounds equal to the visible box | pipeline.md, #61 | 5.1 post-processing, run against the target validator |
| Size limits per role (#61), large environment pieces included; atlas packing is the game's job | pipeline.md, #61 | Target profile limits |
| Manifest `generated` provenance; MIT license; `review.status: "pending"` | pipeline.md, #27 | 5.1 hand-off, 5.9 |
| Stevie and the household in idle, walk, sniff, eat, play and shelter first; later run, climb, forage, drink, groom, lead/follow, sleep, converse/emote | #27, Wave 8 §10.2 | 5.2 animation, 5.6 campaigns |
| Body, face, age and size variants; lifecycle variants; non-distressing historical treatment | Wave 8 §10.2 | 5.3 identity lock, 5.6 variant matrices |
| Props: den, porch, tree, fence, mailbox, trash can, feeder, garden, paths, plants, water | Wave 8 §10.2 | 5.1, 5.8 tiles |
| Weather and time: dry, rain, wetness, puddles, fog, cloud, day, dusk, night, light | Wave 8 §10.2, #21, #66 | 5.5 material maps, 5.8 effects |
| Icons: weather, material events, entity modes, actions, relationships, privacy, status | Wave 8 §10.2 | 5.8 icon families |
| Modular layers and atlases, never one flattened illustration | Wave 8 §10.2 | Per-asset specs; layering in the target profile |
| Look: rendered storybook realism (lightly painterly yard, naturalistic characters per Stevie's turnaround), high three-quarter isometric camera, soft fur, full colour; warm light against cool rain and dusk; Pacific Northwest garden | Wave 8 §10.1, the reference mockup | Style bible, 5.3 |
| Golden scene approval | pipeline.md | 5.4 in-context preview, using the golden renderer |
| Audio: rain loops, ambience, birds, rustling, water, subtle cues; mute and volume groups; nothing conveyed by sound alone; sensory-safe defaults | Wave 8 §10.3 | 5.8 audio |
| Creator-authored world packs (Wave 7), community assets (PRD v0.5 §16) | Wave 7, PRD | 5.7 agent use; the style bible as the creator's guardrail |
| Renderer-neutral future: 2.5D and 3D packs | Architecture §20 | 5.8 3D |
| Git LFS storage for all media | #27, Factory LFS | Format-agnostic, per principle 6 |

## 7. Non-goals

- **No runtime dependency:** a game never calls Assetforge while it runs.
- **No auto-approval,** under any score.
- **No hosted service, asset CDN or storage:** the target's pipeline uploads its approved assets.
- **Not a replacement for an editor:** small fixes stay in normal image tools, and Assetforge re-validates what comes back.
- **No training or fine-tuning** of models on a game's art in this phase. References are passed per request.
- **No photorealism or styles outside the bible,** unless a target's bible asks for them.

## 8. Success measures

These are measured per campaign and recorded in the repository:
- **Cost per approved asset,** and spend against forecast.
- **Picks per request:** the share of requests where a person picked a candidate.
- **QA precision:** the share of candidates shown that the person found acceptable.
- **QA recall:** checked on a sample of the candidates it filtered out.
- **First-pass validator acceptance:** the share of picks the target's validator accepts on the first try.
- **Author minutes per approved asset,** from request to the pick being written.
- **Consistency:** the spread of identity and style scores across an approved set, and the drift report's size after a change to the bible.
- **Time to a complete set,** for Raccoon World's first set and later for the Wave 8 set.

## 9. Architecture outline (what, not how)

- **Core:** the loop. Specs and profiles in, candidates and hand-off out.
- **Gateway adapter:** models through one gateway. Vercel AI Gateway first; its key is `AI_GATEWAY_API_KEY`.
- **Generators:** one per media kind, each with its own post-processing and QA. A new media type is a new generator.
- **Transforms:** the media transformation layer (§5.11). Deterministic operations behind engine adapters, chained as recipes; generators, sheet import and hand-off all use it.
- **QA:** deterministic checks, then vision-model checks, with reasons recorded on each candidate.
- **Surfaces:**
  - the CLI, with JSON output;
  - a local picker;
  - a GitHub Action that opens the pick PR;
  - an MCP server for agents.
- **Storage:** the target repository, with Git LFS. Locks and caches are content-addressed.
- **Language and tooling:** chosen in the first Objective (assetforge#1). Prefer what the first adopter already runs: Node 24, pnpm, TypeScript.

## 10. Open questions

- **Model routes:** which image, edit, video, audio and 3D models the gateway serves today; recorded in the first Objective.
- **Fingerprints:** how to compute the identity and style fingerprints. Vision-model embeddings are the first candidate; this needs a small evaluation.
- **Preview command:** its shape. Clockgrove's golden renderer is the first.
- **Picking:** whether picking happens in PRs from the first campaign, or the CLI picker comes first.
- **Audio:** whether provider terms allow it, and which loudness standard to use.

## 11. Relationship to other projects

- **Each world** owns its style bible, target profile and review. Raccoon World's live in clockgrove/raccoon-world (raccoon-world#2).
- **Clockgrove** owns the platform side: validating external worlds' assets (clockgrove/clockgrove#61), material packing, atlases and KTX2 delivery (clockgrove/clockgrove#66).
- **Factory** builds Assetforge (Objectives) and owns Git LFS persistence and infrastructure.
- **Assetforge** owns generation, post-processing, QA, picking and hand-off.
