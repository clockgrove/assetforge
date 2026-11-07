# Decisions

## Language and tooling (assetforge#1, 2026-11-07)

Chosen so the first adopter, Clockgrove (Node 24, pnpm, TypeScript), runs Assetforge with no new runtime.

- **TypeScript on Node 24, no build step.** Node runs the `.ts` sources directly with its built-in type stripping, so the code uses erasable syntax only (no enums, namespaces or parameter properties) and imports name their `.ts` files. `tsc --noEmit` checks the types.
- **pnpm**, pinned through `packageManager` and enabled with corepack. CI installs with `pnpm install --frozen-lockfile --ignore-scripts`; no dependency needs an install script.
- **Commands:** `pnpm check` runs Prettier, ESLint (typescript-eslint) and `tsc --noEmit`. `pnpm test` runs `node:test` over `test/**/*.test.ts`, offline with the scripted provider. `pnpm test:real` runs the opt-in real-provider checks in `test/real/`, which skip without `AI_GATEWAY_API_KEY`.
- **Runtime dependencies:** `ai` (the Vercel AI SDK, imported only by `src/gateway/vercel.ts`), `pngjs` and `jpeg-js` (pure-JavaScript image codecs). TypeScript stays on 6.0, the newest version typescript-eslint supports.

## Release-age exclusion for the `ai` SDK (assetforge#1, 2026-11-07)

`pnpm-workspace.yaml` lists `ai` and its three `@ai-sdk/*` packages, at exact versions, under `minimumReleaseAgeExclude`. pnpm 12's default release-age policy refuses versions published too recently; the dependency was pinned to the newest `ai` release on the day of implementation (`ai@7.0.165`, published 2026-11-07), so the gateway adapter was written and checked against the current SDK, and that release and its matching `@ai-sdk/*` packages were still inside the window. The exclusion names exact versions only, so any other version, including a later update, still waits out the window. Remove the file once those versions are older than the window (any day after 2026-11-08) and run `pnpm install` to confirm the lockfile is unchanged.

## Animation (owner, 2026-11-07)

Key pose first, then each frame a reference-guided edit of it. The key pose is approved by the author before any frame is edited: a sprite-strip spec must name it as `keyPose`, and Assetforge refuses a strip spec without one before any spend. The approved path is two runs: stage a `still` of the pose, choose one of the staged candidates (or any author-made image), then stage the strip with that file as `keyPose`. Video-to-frames comes later as another generator.

## Picking (owner, 2026-11-07)

The operator picks. `assetforge stage` stages only QA-passing candidates with their reasons; `assetforge pick` writes the chosen one with the review field at the profile's pending value. Assetforge never writes any other review value.

## License of generated output (Kirk, 2026-11-07)

Assetforge writes the license value the target profile declares (Clockgrove: MIT) and records the models, route and provider terms in provenance.
