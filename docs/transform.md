# Media transformation (images)

The transformation core (PRD §5.11) runs deterministic image operations on any image: generated, imported or hand-made. Operations chain into recipes, which are declared as data. Engines sit behind one adapter, and every operation records one provenance step. The sheet import ([sheet-import.md](sheet-import.md)) is built on it.

## Commands

```sh
# One operation. With --profile, the target profile's style and frame size supply the defaults.
pnpm assetforge op matte hand-painted.png --out clean.png
pnpm assetforge op trim clean.png --out trimmed.png --params '{"margin": 2}' --profile profile.json

# A recipe file.
pnpm assetforge recipe sheet-to-renditions.json sheet.png --out out/ --profile profile.json

# Every operation, its parameter schema, and the engines that implement it.
pnpm assetforge ops --json
```

All three follow the CLI contract: `--json` prints one JSON document, nothing prompts, and invalid input exits 2. A single output goes to `--out` when that path has an extension. Otherwise `--out` is a directory, and each output is written there as `<name>.<extension>`. The provenance record goes beside the output, as `<out>.provenance.json` or `<dir>/provenance.json`. An input file is never overwritten.

Outputs are named after the source file. `slice` adds `-f001`, `-f002` and so on, `renditions` adds `@1x` and `@2x`, and `join` adds `-strip` or `-sheet`.

## Operations

| Operation     | Scope | What it does                                                                                                                                                                                                                                                                                                           |
| ------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crop`        | each  | Cuts out `x`, `y`, `width`, `height`. A box outside the image is refused.                                                                                                                                                                                                                                              |
| `trim`        | each  | Cuts to the box of pixels whose alpha is at or above `threshold` (default: the style profile's threshold), keeping `margin` px.                                                                                                                                                                                        |
| `pad`         | each  | Adds transparent `top`, `right`, `bottom` and `left` px.                                                                                                                                                                                                                                                               |
| `scale`       | each  | Resamples by exactly one of `factor`, `width` or `height` (the aspect is kept). `filter` defaults to the style's edges: `crisp` (nearest neighbour) or `antialiased` (premultiplied).                                                                                                                                  |
| `slice`       | each  | Splits a sheet into figures, dropping labels, specks and background. Takes `grid`, `components`, `tolerance`, `labelFraction` and `padding`, as the sheet import does.                                                                                                                                                 |
| `matte`       | each  | Removes the background to the style profile, unmixing a soft edge band and removing halo and fringe. It runs the halo and leftover-background checks (`maxHaloFraction`). An image that was not sliced first has its figures located as connected components and is matted onto a transparent canvas of the same size. |
| `apply-style` | each  | Re-applies the style's binary alpha and palette snap, and clears the colour of transparent pixels.                                                                                                                                                                                                                     |
| `register`    | all   | Puts every image into one `frame` size (default: the profile's frames), with its feet baseline and centre of mass on `anchor` (default: the bottom centre) at one common scale. `families` normalises scale within each family. The jitter is recorded per image.                                                      |
| `join`        | all   | Assembles the images left to right into `columns` columns (default: one row, a strip). Cells are the size of the largest image, and images sit top-left in them.                                                                                                                                                       |
| `flip`        | each  | Mirrors each image: `direction` is `horizontal` (left and right) or `vertical`.                                                                                                                                                                                                                                        |
| `renditions`  | each  | Makes one copy per entry in `scales` (default `[1, 2]`). The input is treated as 1x.                                                                                                                                                                                                                                   |
| `convert`     | each  | Sets the format an image is written in, by extension or media type. The engine decides which formats exist. The in-house engine encodes PNG and lossless WebP.                                                                                                                                                         |

`assetforge ops --json` lists each operation's parameter schema. The schemas use a small JSON Schema subset: types, `enum`, bounds, `required` and `default`. Unknown parameters are refused.

## Recipes

```json
{
  "format": "assetforge-recipe/1",
  "name": "sheet-to-renditions",
  "steps": [
    { "op": "slice" },
    { "op": "matte" },
    { "op": "register", "params": { "frame": { "width": 64, "height": 64 } } },
    { "op": "trim" },
    { "op": "pad", "params": { "top": 2, "right": 2, "bottom": 2, "left": 2 } },
    { "op": "scale", "params": { "factor": 0.5 } },
    { "op": "renditions", "params": { "scales": [1, 2] } },
    { "op": "convert", "params": { "format": "webp" } }
  ]
}
```

Recipes are JSON. Every step is checked against its operation's schema before anything runs. A step may name an `engine`. Without one, the first engine that implements the operation runs it.

Recipes are deterministic. The same input, recipe and engine versions give the same output bytes. Nothing reads a clock or a random source, and the provenance record holds no time.

## Provenance

The record (`generator: "transform"`) lists:

- `sources`: each input's path, file SHA-256, media type and pixel hash;
- `style`: the style the operations followed;
- `steps`: one per operation, holding `op`, `params` with defaults filled in, `engine` (`name` and `version`), and the `inputs` and `outputs` pixel hashes. Some steps add a `report`, such as a slice's grid or the common registration scale;
- `outputs`: each file's path, SHA-256, media type, size, pixel hash and what the operations measured (matte checks, jitter).

A pixel hash is the SHA-256 of `rgba8 <width>x<height>\n` followed by the RGBA bytes. Steps are chained by pixel hashes, so no intermediate image has to be encoded.

Strips written by the sheet import carry the same `steps` in their provenance: the import's `slice` and `matte`, then the write's `flip`, `register`, `apply-style` and `join`.

## Engines

An engine adapter (`ImageEngine` in `src/transform/types.ts`) has a name, a version, the operations it implements, its encoders by media type, and a decoder. The in-house engine, `assetforge-raster`, is Assetforge's own TypeScript raster code. It decodes PNG and JPEG, and encodes PNG and lossless WebP (VP8L). Its version is bumped whenever any operation's output bytes change.

Another engine, such as sharp/libvips, ImageMagick or a model-based matte, implements some of the same operations and is passed to the runner ahead of the in-house engine, or named by a step. Recipes don't change. KTX2 output comes with the material-maps work (#14).

## Programmatic use

`runOperation`, `runRecipe`, `parseRecipe` and `transformFiles` in `src/transform/run.ts` are the entry points. The CLI calls them, and so will the MCP tools and campaigns.
