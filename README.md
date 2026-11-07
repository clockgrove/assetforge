# Assetforge

Assetforge generates game assets — sprites, animation strips, and later video, audio and 3D — through image and video generation models, and hands them to a game's own asset pipeline with full provenance.

It is a development tool. A game repository never depends on it at runtime: Assetforge writes files and their manifests in the format the game declares, and the game's own validator and human review decide what enters the game.

## How it works

1. **Spec, not freehand.** Each request starts from the target asset's spec (asset, animation family, frame count and size, anchor) and the world's style bible (approved reference images, palette, perspective).
2. **Candidates.** Models behind one gateway adapter produce several candidates per request, within a per-run cost cap.
3. **Post-processing to spec.** Background to true alpha, crop and scale to the frame grid, palette and pivot alignment.
4. **Vision QA.** A vision model checks each candidate against the spec and the references; only passing candidates are shown.
5. **Operator pick.** A person picks and approves. Nothing is accepted automatically.
6. **Hand-off.** The chosen files and their provenance are written into the target repository for its pipeline; media is stored with Git LFS.

Animation is generated as a whole contact sheet per cycle, sliced and registered into frames; a single bad frame is fixed by a reference-guided edit.

## Usage

Assetforge runs on Node 24 with pnpm (see [docs/decisions.md](docs/decisions.md)).

```sh
pnpm install
export AI_GATEWAY_API_KEY=...   # the Vercel AI Gateway key, from the environment only
pnpm assetforge stage --spec stevie-shelter.json --bible bible.json --profile profile.json
pnpm assetforge pick --run .assetforge/runs/<run> --candidate c2 --target ../clockgrove
```

`stage` reserves the run's estimated cost against the cap (default 4 candidates and $5; `--candidates`, `--cap`) and refuses a run that would exceed it, then lists only the candidates that passed QA, each with its reasons. `pick` writes the chosen file and its manifest into the target with the review status pending and full provenance, and runs the target's validator. The input formats are in [docs/target-profile.md](docs/target-profile.md); the gateway's models and the default routes are in [docs/models.md](docs/models.md).

`pnpm check` and `pnpm test` run offline with a scripted provider. `pnpm test:real` runs the opt-in real-provider check, which skips without a key.

## Status

Pre-1.0 and under active design. The first adopter is [Clockgrove](https://github.com/clockgrove/clockgrove)'s Raccoon World.

## License

Assetforge is licensed under the [MIT License](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
