/**
 * A synthetic target validator for 3D characters, standing in for a target repository's own.
 * Usage: node validator-3d.ts <manifest path relative to the cwd>. Exit 0 accepts; 1 lists failures.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const manifestPath = process.argv[2] ?? "";
const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const failures: string[] = [];
const fail = (rule: string, detail: string) => failures.push(`${rule}: ${detail}`);

const glb = readFileSync(m["source"].path);
if (glb.subarray(0, 4).toString("latin1") !== "glTF") fail("format", "not a binary glTF");
if (m["source"].mediaType !== "model/gltf-binary") fail("mediaType", m["source"].mediaType);
const hash = createHash("sha256").update(glb).digest("hex");
if (m["contentHash"] !== hash) fail("contentHash", `${m["contentHash"]} is not ${hash}`);
if (m["review"]?.status !== "pending") fail("review", "must be pending");
if (!["MIT", "CC-BY-4.0"].includes(m["license"])) fail("license", m["license"]);
if (m["license"] === "CC-BY-4.0" && !m["credit"]) fail("credit", "CC BY needs a credit line");
const budgets = { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 };
for (const [key, max] of Object.entries(budgets)) {
  if (!(m["model"]?.[key] <= max)) fail(`budget ${key}`, `${m["model"]?.[key]} > ${max}`);
}
if (!Array.isArray(m["model"]?.clips)) fail("clips", "missing");
if (!(m["model"]?.bounds?.min?.[1] >= -1e-6)) fail("ground", "the model is below the ground");

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok ${m["assetId"]}`);
