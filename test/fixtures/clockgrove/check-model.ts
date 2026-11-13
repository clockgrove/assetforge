/**
 * Runs Clockgrove's model validator, vendored beside this file, on one written model manifest:
 * `node check-model.ts <manifest> <model-target.json>`, in the target directory. It decodes the
 * manifest and the model target profile with Clockgrove's contract, reads the `.glb` at
 * `output.path`, and checks it with Clockgrove's `validateModel`, as Clockgrove's asset CLI does.
 * Exits 1 with the problems when the validator refuses. Assetforge's glue, not Clockgrove code.
 */
import { readFileSync } from "node:fs";
import { decodeModelAssetManifest, decodeModelTargetProfile } from "./model-asset.ts";
import { validateModel } from "./model.ts";

const [manifestPath, profilePath] = process.argv.slice(2);
if (!manifestPath || !profilePath) {
  process.stderr.write("usage: check-model.ts <manifest> <model-target.json>\n");
  process.exit(2);
}
try {
  const manifest = decodeModelAssetManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const profile = decodeModelTargetProfile(JSON.parse(readFileSync(profilePath, "utf8")));
  const problems = validateModel(
    manifest,
    new Uint8Array(readFileSync(manifest.output.path)),
    profile,
  );
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${manifest.assetId}: accepted\n`);
  }
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
