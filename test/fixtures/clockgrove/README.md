# Clockgrove's model validator (vendored)

Clockgrove's model validator, so a test can hand Assetgrove's 3D output to the real thing offline (assetgrove#137). Source: [clockgrove/clockgrove](https://github.com/clockgrove/clockgrove) at commit `2bade8b60d931dfc1324613c3eb422a3314277d0`. MIT, Copyright 2026 Clockgrove (Clockgrove's `REUSE.toml` and `LICENSES/MIT.txt`).

| File                | From                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `model-asset.ts`    | `packages/contracts/src/model-asset.ts`                                                    |
| `validation.ts`     | `packages/contracts/src/validation.ts`                                                     |
| `model.ts`          | `packages/assets/src/model.ts`                                                             |
| `inspect-model.mjs` | `packages/assets/src/inspect-model.mjs`                                                    |
| `asset-manifest.ts` | the types `model-asset.ts` imports from `packages/contracts/src/asset-manifest.ts`         |
| `validate.ts`       | `sha256Hex` from `packages/assets/src/validate.ts`                                         |
| `check-model.ts`    | Assetgrove's: runs the validator on one manifest, as Clockgrove's asset CLI does per model |

The first four are unchanged except their relative import specifiers (`.js` to `.ts`, `@clockgrove/contracts` to `./model-asset.ts`), so Node runs them without a build. `inspect-model.mjs` needs the `@gltf-transform/core`, `@gltf-transform/extensions` and `meshoptimizer` versions Clockgrove pins; they are Assetgrove dev dependencies.

To update: copy the files from a newer Clockgrove commit, redo the import specifiers, and change the commit above.
