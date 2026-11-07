# Decisions

## Language and tooling (assetforge#1, 2026-11-07)

Chosen so the first adopter, Clockgrove (Node 24, pnpm, TypeScript), runs Assetforge with no new runtime.

- **TypeScript on Node 24, no build step.** Node runs the `.ts` sources directly with its built-in type stripping, so the code uses erasable syntax only (no enums, namespaces or parameter properties) and imports name their `.ts` files. `tsc --noEmit` checks the types.
- **pnpm**, pinned through `packageManager` and enabled with corepack. CI installs with `pnpm install --frozen-lockfile --ignore-scripts`; no dependency needs an install script.
- **Commands:** `pnpm check` runs Prettier, ESLint (typescript-eslint) and `tsc --noEmit`. `pnpm test` runs `node:test` over `test/**/*.test.ts`, offline with the scripted provider. `pnpm test:real` runs the opt-in real-provider checks in `test/real/`, which skip without `AI_GATEWAY_API_KEY`.
- **Runtime dependencies:** `ai` (the Vercel AI SDK, imported only by `src/gateway/vercel.ts`), `pngjs` and `jpeg-js` (pure-JavaScript image codecs). TypeScript stays on 6.0, the newest version typescript-eslint supports.

## Animation (owner, 2026-11-07)

Key pose first, then each frame a reference-guided edit of it. A sprite-strip spec may name an author-approved key pose (`keyPose`), for example a still picked through the same loop; without one, each candidate generates its own key pose first, and picking the strip approves that pose with it. Video-to-frames comes later as another generator.

## Picking (owner, 2026-11-07)

The operator picks. `assetforge stage` stages only QA-passing candidates with their reasons; `assetforge pick` writes the chosen one with the review field at the profile's pending value. Assetforge never writes any other review value.

## License of generated output (Kirk, 2026-11-07)

Assetforge writes the license value the target profile declares (Clockgrove: MIT) and records the models, route and provider terms in provenance.
