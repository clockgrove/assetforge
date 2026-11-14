import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRaster, encodePng, getPixel, setPixel } from "../src/image/raster.ts";
import { describeOperations, parseRecipe, runRecipeAsync } from "../src/transform/run.ts";
import { targetCommand } from "../src/material/engine.ts";

test("registered material operations run in recipes with exact geometry and chained provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "material-recipe-"));
  const raster = createRaster(4, 4);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) setPixel(raster, x, y, [128, 128, 128, 255]);
  const path = join(dir, "height.png");
  await writeFile(path, encodePng(raster));
  const grid = { width: 4, height: 4, count: 1 };
  const recipe = parseRecipe({
    steps: [
      {
        op: "material-height",
        params: { grid, method: "mask-extraction", version: "synthetic-1", path },
      },
      {
        op: "material-normal",
        params: { grid, method: "height-derived-normal", version: "synthetic-1" },
      },
      {
        op: "material-rendition",
        params: { grid: { width: 2, height: 2, count: 1 }, scale: 1, native: 2, normal: true },
      },
    ],
  });
  const item = { name: "shape", raster, mediaType: "image/png", meta: {} };
  const result = await runRecipeAsync(recipe, [item]);
  assert.deepEqual(getPixel(result.items[0]!.raster, 1, 1), [128, 128, 255, 255]);
  assert.equal(result.items[0]!.raster.width, 2);
  assert.deepEqual(result.steps[0]!.outputs, result.steps[1]!.inputs);
  assert.deepEqual(result.steps[1]!.outputs, result.steps[2]!.inputs);
  assert.equal(result.steps[0]!.report!["version"], "synthetic-1");
  for (const name of ["height", "normal", "emissive", "roughness", "wind", "rendition", "encode"]) {
    const declaration = describeOperations().operations.find(
      (op) => op.name === `material-${name}`,
    );
    assert.ok(declaration?.engines.includes("assetgrove-material"));
    assert.equal(declaration?.params.type, "object");
  }
  await assert.rejects(
    runRecipeAsync(
      { steps: [{ op: "material-rendition", params: { grid, scale: 2, native: 1 } }] },
      [item],
    ),
    /native resolution/,
  );
  assert.throws(
    () =>
      parseRecipe({
        steps: [{ op: "material-height", params: { grid, method: "invented", version: "1" } }],
      }),
    /must be one of/,
  );
  assert.deepEqual(await readFile(path), Buffer.from(encodePng(raster)));
});

test("bounded argv commands retain failed exit codes and output without a shell", async () => {
  const dir = await mkdtemp(join(tmpdir(), "material-command-"));
  await assert.rejects(
    targetCommand(
      [
        process.execPath,
        "-e",
        "console.log(process.argv[1]);console.error('failure');process.exit(7)",
        "$(false);literal",
      ],
      {},
      dir,
    ),
    (error: unknown) => {
      const record = (
        error as { commandRecord: { exitCode: number; stdout: string; stderr: string } }
      ).commandRecord;
      assert.equal(record.exitCode, 7);
      assert.equal(record.stdout, "$(false);literal\n");
      assert.equal(record.stderr, "failure\n");
      return true;
    },
  );
});
