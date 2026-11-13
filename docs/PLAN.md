# Assetforge implementation plan

This plan breaks [the PRD](PRD.md) into waves. Each wave has:
- an outcome;
- an **exit**, measured on real output, that gates the next wave;
- the Objectives that deliver it.

There are no dates; a wave starts when the one before has met its exit. Objectives are filed as GitHub issues and run through Factory. Each states a goal, outcomes and context, and leaves the implementation to the worker. Each wave's target-side work is an Objective in the target's repository: clockgrove/raccoon-world for Raccoon World's art, clockgrove/clockgrove for platform support.

## Wave 0: the first loop, in 3D

Raccoon World's characters are real-time 3D (Kirk, 2026-11-10; see [decisions.md](decisions.md)), so the first loop is a character model, not a sprite strip.

**Outcome:** one character end to end in real-time 3D. Stevie's approved turnaround and the style bible go in. Candidate models come out of the gateway and are QA-filtered on turntable renders against his identity lock. A person picks one, and the pick, rigged and with a walk clip, is written to the target as glTF with its provenance. PRD §5.8 (3D), brought forward.

**Objectives:**
- Assetforge: image-to-3D characters (assetforge#72, merged). Generation from the approved turnaround, a rig, library clips, turntable renders for QA and the pick, polygon and texture budgets from the target profile, and the provider's output grant in provenance (assetforge#47).
- clockgrove/raccoon-world: a target profile that declares 3D characters, and Stevie's spec.
- clockgrove/clockgrove: the live renderer shows a world's rigged characters through its world-content extension point (clockgrove/clockgrove#112).

**Exit:** a rigged Stevie `.glb` with a walk clip, made by Assetforge:
- the target validator accepts it on the first try;
- it costs at most $5 for 4 candidates;
- it has complete provenance, including the provider's output grant;
- the person picked it from QA-passing candidates only;
- it shows in the live yard.

## Wave 1: Stevie's families and the cast

**Outcome:** animation that holds together on one rig, and Raccoon World's cast. PRD §5.2 and the identity lock from §5.3, in 3D.

**Objectives:**
- A shared raccoon rig and generated gait (assetforge#84): one skeleton template fitted to every raccoon, with locomotion generated from a gait profile tuned to real footage, and foot-contact, joint-limit and skinning QA. Then clips for idle, sniff, eat, play and shelter on the same rig, generated or custom (Kirk, 2026-11-10): generated from the target's declared motions (assetforge#135; docs/characters-3d.md, "Motions besides walking").
- The identity lock on turntables: v1's references and threshold, scored on rendered views.
- Character look-dev (assetforge#82): an albedo in the target's character look (for Raccoon World, Stevie's approved turnaround: naturalistic illustrated fur, not photographic and not heavily painterly; Kirk, 2026-11-11), fur groom maps for the target's fur material, and eyes that catch light. Desktop quality first; phones may run a lighter tier (Kirk, 2026-11-10).
- Gracie, Juniper, a kit and Jimothy as rigged models from their approved references. Gracie joined on 2026-11-10 (Kirk); her signature is the lighter, greyer, longer fur on her lower body (clockgrove/raccoon-world `references/gracie/`).
- Raccoon World: the cast approved and committed to clockgrove/raccoon-world.

**Exit:**
- Stevie's six families approved and showing in the live yard.
- At least 70% of requests end in a pick.
- Cost per approved asset and author minutes per approved asset recorded.

The 2D path shipped first and stays: sheet generation and import (assetforge#10), the media transformation core (PRD §5.11), loop and continuity QA, and identity lock v1. It serves props, terrain, effects and UI, and targets that use sprites; wave 4 covers them. Raccoon World's first 2D shelter run is recorded in clockgrove/raccoon-world PR #21.

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
- One Factory Objective in clockgrove/raccoon-world that stages assets through the agent interface.

## Wave 4: the full 2D set

**Outcome:** everything Wave 8 §10.2 of Clockgrove needs in 2D (props, terrain, effects, icons and portraits; characters are 3D from wave 0), as lit materials. PRD §5.5 and the 2D generators of §5.8.

**Objectives:**
- Material maps by default: normal and height/depth, emissive and roughness/wetness, wind/flow; 1× and 2× renditions, and KTX2 for targets without their own texture build (Clockgrove encodes KTX2 from its packed atlases instead, clockgrove/clockgrove#66); temporal stability bounds; lit-preview QA against the target's light rig.
- Generators for effects, tiles and terrain, icon families, and portraits with expressions.
- Clockgrove: night and rain lighting use the maps (clockgrove/clockgrove#66).

**Exit:**
- The Wave 8 §10.2 2D asset list is produced and approved.
- The yard is lit from the maps by the renderer the bake-off chose (Clockgrove #67), with no per-lighting-state sprites, and maps are stable across animation frames.
- The icon families pass the contrast and colour-blind checks.

## Wave 5: audio

**Outcome:** the soundscape Wave 8 §10.3 of Clockgrove asks for. PRD §5.8, audio.

**Objectives:**
- Audio transforms (PRD §5.11): trim, split, merge, fades, loop points, resample, loudness normalization and format conversion.
- An audio generator: ambient loops at several rain intensities, birds, rustling, water and cues. Seamless loop points, loudness normalization, and level groups and sensory-safe defaults from the target profile.

**Exit:**
- Raccoon World's audio set approved: the loops play seamlessly and the levels stay in range.
- Every sound has provenance and license values the target accepts.

## Wave 6: video and 3D

**Outcome:** the next media types, through new generators and no core change. PRD §5.8, video and 3D props (3D characters came first, in waves 0 and 1).

**Objectives:**
- Video transforms (PRD §5.11): trim, split, concatenate, frame extraction into the sheet import, frames to video, and format conversion.
- Video: short UI and effect loops, and video-to-frames as a second animation route, compared against sheet generation on identity and loop scores.
- 3D: image-to-3D props as `.glb`, with turntable renders for QA and the pick, and polygon and texture budgets from the target profile.

**Exit:**
- One `.glb` prop picked from turntables and accepted by a target profile that declares 3D.
- Video-to-frames compared with sheet generation on Stevie's walk, and the better route recorded.

## Wave 7: 1.0, a second adopter

**Outcome:** proof that Assetforge is generic. PRD principle 1 and §3.

**Objectives:**
- A second target with no code change and a different style profile (flat cartoon or pixel art). Clockgrove's fixture world (`worlds/fixture`) is the first candidate.
- Documentation for adopters: writing a target profile and a style bible, and running campaigns.

**Exit:**
- The second target's first set approved with no Assetforge code changes.
- Five campaigns in a row with no failed hand-off.

## Cadence and rules

- Exact tags and releases. Clockgrove pins Assetforge only for development tooling; the game never depends on it at runtime.
- Each Objective's tests run offline with the scripted provider. Real-provider checks are opt-in, and they are how a wave's exit is measured.
- Spend: a per-run cap, a per-campaign budget and Factory's daily cap for the repository. Raising any of them is the owner's call.
- Measures (PRD §8) are recorded per campaign in the repository. The exits read them.
