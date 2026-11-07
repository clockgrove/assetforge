# Assetforge implementation plan

This plan breaks [the PRD](PRD.md) into waves. Each wave has:
- an outcome;
- an **exit**, measured on real output, that gates the next wave;
- the Objectives that deliver it.

There are no dates; a wave starts when the one before has met its exit. Objectives are filed as GitHub issues and run through Factory. Each states a goal, outcomes and context, and leaves the implementation to the worker. Clockgrove's side of each wave is a Clockgrove Objective.

## Wave 0: the first loop

**Outcome:** one asset, end to end. A spec and a style bible go in. Candidates come out of the gateway, are post-processed and QA-filtered, a person picks one, and the pick and its provenance are written to the target. PRD §5.1.

**Objectives:**
- assetforge#1, the generic generation loop. Its tooling is chosen and recorded there.
- clockgrove/clockgrove#27, Clockgrove's side: style bible, target profile, validator support.

**Exit:** a `shelter` strip of Stevie made by Assetforge:
- the target validator accepts it on the first try;
- it costs at most $5 for 4 candidates;
- it has complete provenance;
- the person picked it from QA-passing candidates only.

## Wave 1: animation and the first Raccoon World set

**Outcome:** character animation that holds together, and Raccoon World's first real set. PRD §5.2, plus the identity lock from §5.3.

**Objectives:**
- Sprite-sheet import and sheet generation (assetforge#10): slicing, soft alpha, label stripping, baseline registration, and family grouping with a person confirming. Then per-frame fixes, with motion templates for idle, walk, sniff, eat, play and shelter. Stevie's existing 57-frame sheet is the first import.
- Loop and continuity QA, with an onion-skin sheet and a loop preview at pick time.
- Identity lock v1: each character's references and fingerprint; candidates below the threshold are filtered out with the reason.
- Clockgrove: the first set approved and in the golden scene (the rest of #27).

**Exit:**
- Stevie's six families approved and showing in the live yard.
- At least 70% of requests end in a pick.
- Cost per approved strip and author minutes per approved strip recorded.

## Wave 2: consistency and context

**Outcome:** a world that stays consistent as it grows, with each pick made in the game's own scene. PRD §5.3 and §5.4.

**Objectives:**
- Style distance on every candidate, and a set-level colour and lighting audit.
- An asset lock per approved asset, and a drift report when the style bible changes version.
- In-context preview through the target's preview command. Clockgrove's golden renderer is the first.

**Exit:**
- The set-level audit runs on the whole Raccoon World set.
- A test change to the bible version yields a correct drift report.
- Picks happen on in-context renders, and first-pass validator acceptance stays at or above Wave 1's.

## Wave 3: campaigns, PR picking and agents

**Outcome:** whole sets, picked where review already happens, and usable from inside a Factory Objective. PRD §5.6 and §5.7.

**Objectives:**
- Variant matrices and campaigns with a cost forecast, ordering, progress and resume.
- A GitHub Action that opens the pick PR in the target repository: a gallery comment, picks by checkbox or reply, rejected candidates removed.
- An agent interface (JSON CLI and MCP server) that can stage candidates and open the pick PR, but never pick or approve.

**Exit:**
- One Raccoon World campaign of at least 30 assets, picked entirely in PRs.
- Its actual cost within 20% of the forecast.
- One Factory Objective in Clockgrove that stages assets through the agent interface.

## Wave 4: the full 2D set

**Outcome:** everything Wave 8 §10.2 of Clockgrove needs in 2D, lit dynamically. PRD §5.5 and the 2D generators of §5.8.

**Objectives:**
- Relightable sprites: normal, emissive and wetness maps on request.
- Generators for effects, tiles and terrain, icon families, and portraits with expressions.
- Clockgrove: night and rain lighting use the maps (follows #21).

**Exit:**
- The Wave 8 §10.2 2D asset list is produced and approved.
- The yard relights from the maps with no per-lighting-state sprites.
- The icon families pass the contrast and colour-blind checks.

## Wave 5: audio

**Outcome:** the soundscape Wave 8 §10.3 of Clockgrove asks for. PRD §5.8, audio.

**Objectives:**
- An audio generator: ambient loops at several rain intensities, birds, rustling, water and cues. Seamless loop points, loudness normalization, and level groups and sensory-safe defaults from the target profile.

**Exit:**
- Raccoon World's audio set approved: the loops play seamlessly and the levels stay in range.
- Every sound has provenance and license values the target accepts.

## Wave 6: video and 3D

**Outcome:** the next media types, through new generators and no core change. PRD §5.8, video and 3D.

**Objectives:**
- Video: short UI and effect loops, and video-to-frames as a second animation route, compared against key-pose editing on identity and loop scores.
- 3D: image-to-3D props as `.glb`, with turntable renders for QA and the pick, and polygon and texture budgets from the target profile.

**Exit:**
- One `.glb` prop picked from turntables and accepted by a target profile that declares 3D.
- Video-to-frames compared with sheet generation on Stevie's walk, and the better route recorded.

## Wave 7: 1.0, a second adopter

**Outcome:** proof that Assetforge is generic. PRD principle 1 and §3.

**Objectives:**
- A second target with no code change. Clockgrove's non-raccoon `mirror-room` test pack is the first candidate.
- Documentation for adopters: writing a target profile and a style bible, and running campaigns.

**Exit:**
- The second target's first set approved with no Assetforge code changes.
- Five campaigns in a row with no failed hand-off.

## Cadence and rules

- Exact tags and releases. Clockgrove pins Assetforge only for development tooling; the game never depends on it at runtime.
- Each Objective's tests run offline with the scripted provider. Real-provider checks are opt-in, and they are how a wave's exit is measured.
- Spend: a per-run cap, a per-campaign budget and Factory's daily cap for the repository. Raising any of them is the owner's call.
- Measures (PRD §8) are recorded per campaign in the repository. The exits read them.
