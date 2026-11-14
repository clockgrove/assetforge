# Assetgrove plan

This plan delivers [the 1.0 PRD](PRD.md) in four phases, taken from its [Scope of 1.0](PRD.md#scope-of-10). Each phase ends at a gate that checks everything in it, and the next phase builds on what the gate proved. Every phase ships its skills with its code: a feature isn't done until the skill that teaches an agent to use it is. Each work area states what, not how; the PRD section linked holds the detail.

## Phase 1: safe core

**Outcome:** a core that is safe to share and complete enough that later phases only add. Every operation runs through the official SDKs, a person confirms picks and spend in every supported harness, shared files can't run code or steer keys, and the core is on npm. See [Phase 1: safe core](PRD.md#phase-1-safe-core) and [What the controls stop, and what they don't](PRD.md#what-the-controls-stop-and-what-they-dont).

**Work areas:**

- Every CLI operation as an MCP tool on the official MCP SDK, with progress for long generations and runs that survive a dropped connection.
- Confirmation per harness, proven in Claude Code locally, in a remote session, and in one more harness; a headless mode for unattended runs, set by the operator outside the repository.
- Spend: a limit at the provider required at `init`, caps in the developer's own settings that only a person raises, the ledger compared with the provider's usage, and cost decided by the provider's adapter.
- Shared files: no commands or endpoints taken from shared files; developer-written commands run only after an approval tied to that exact command.
- Keys and licences: a recipe per harness for where the key goes, redacted provider errors, and no hand-off for a route without a declared grant.
- The prompt policy, best-effort, before spend.
- Generic settings in place of those named after a CI product.
- The rest of the core: the extension contract, core routes (Vercel AI Gateway, Anthropic, OpenAI and any OpenAI-compatible endpoint), generic sprite-atlas hand-off, runs that resume and never pay twice, versioned shared files, `init` with the style bible, and the skills in the Agent Skills format. See [What we build on](PRD.md#what-we-build-on) and [Trust, safety and legal](PRD.md#trust-safety-and-legal).
- Linux, macOS and Windows in CI.
- A trademark check on the name.

**Gate:** everything above checked, the data-dependent bars in [Success measures and the 1.0 exit](PRD.md#success-measures-and-the-10-exit) set, and a release candidate, version 0.1.0, ready to publish to npm.

## Phase 2: asset management and search

**Outcome:** everything Assetgrove makes becomes a library a developer and their agent can browse, review, change and search. See [Phase 2](PRD.md#phase-2-asset-management-and-search) and the [Assetgrove Search PRD](PRD-search.md).

**Work areas:**

- Asset cards in the Open Knowledge Format, with an index and a log per folder.
- The `asset://` tree as MCP resources, walked by `assetgrove ls` and `cat`.
- Review and changes: a version stack per asset, `request_change` by region, compare contact sheets, and review records as W3C Web Annotation.
- Locks and drift reports when the style bible changes.
- Storage: picks committed with media in Git LFS, set up and checked by `init`.
- The optional search add-on, with its own skill.
- The set-level audit.

**Gate:** on a labelled test library, every asset has a card, reviews and change requests round-trip through new versions, and search meets the bars set for it before the run. Published as 0.2, with search as its own package; outside developers are invited from here.

## Phase 3: extensions

**Outcome:** engines, asset kinds and routes as their own packages on the Phase 1 contract, each with its own skill, landing in the order feedback asks for. See [Phase 3](PRD.md#phase-3-extensions).

**Work areas:**

- The Godot pack, checked in CI by a headless Godot import on a pinned version.
- Asset-kind packs: tile sets, UI icon families, and pixel art proven first by a spike with its pass numbers set in advance.
- Route packs: ComfyUI, one specialist pixel-art vendor, image-to-3D through fal, and a free local pre-check for vision QA.

**Gate:** the required packs (the Godot pack, and the pixel-art, tile and icon kinds) are on npm and pass their checks.

## Phase 4: product marketing and developer relations

**Outcome:** Assetgrove in front of developers, and their unaided success. See [Phase 4](PRD.md#phase-4-product-marketing-and-developer-relations).

**Work areas:**

- Positioning and launch, with listings in skills and MCP directories.
- Learning material: a quick start, walkthrough videos and skills, built on a small example project.
- Outside developers recruited with a time box, and their feedback and run reports collected.
- Community: issue templates and one place for feedback.

**Gate:** the [1.0 exit](PRD.md#success-measures-and-the-10-exit): outside developers reach a committed asset set on their own and the measures hold. 1.0 is tagged on npm.

Work outside these phases is listed in [After 1.0](PRD.md#after-10).
