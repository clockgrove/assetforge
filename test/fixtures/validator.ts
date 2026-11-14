/**
 * A synthetic target validator, standing in for a target repository's own: it applies typical
 * rules to a manifest and its strip.
 * Usage: node validator.ts <manifest path relative to the cwd>. Exit 0 accepts; 1 lists failures.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

interface Manifest {
  assetId: string;
  animationFamily: string;
  source: { kind: string; path: string };
  license: string;
  review: { status: string };
  frames: { width: number; height: number; count: number };
  bounds: { x: number; y: number; width: number; height: number };
  palette?: string[];
  /** The world's style profile, when the profile's template passes it through. */
  style?: { alpha?: { mode: string; threshold?: number }; color?: { rule: string } };
  contentHash: string;
  provenance: { generated: Record<string, unknown> };
}

const manifestPath = process.argv[2] ?? "";
const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const failures: string[] = [];
const fail = (rule: string, detail: string) => failures.push(`${rule}: ${detail}`);

if (manifestPath !== `assets/manifests/${m.assetId}/${m.animationFamily}.json`) {
  fail("layout", `manifest at ${manifestPath}`);
}
if (m.source.path !== `assets/source/${m.assetId}/${m.animationFamily}.png`) {
  fail("layout", `source at ${m.source.path}`);
}
if (m.license !== "MIT") fail("license", m.license);
if (m.review.status !== "pending") fail("review", `status ${m.review.status}`);
for (const key of [
  "route",
  "models",
  "prompt",
  "parameters",
  "requestIds",
  "startedAt",
  "costUsd",
]) {
  if (m.provenance.generated[key] === undefined) fail("provenance", `missing ${key}`);
}

const bytes = readFileSync(m.source.path);
if (createHash("sha256").update(bytes).digest("hex") !== m.contentHash)
  fail("contentHash", "mismatch");
const png = PNG.sync.read(bytes);
const ihdr = { depth: bytes[24], colorType: bytes[25] };
if (ihdr.depth !== 8 || ihdr.colorType !== 6) fail("transparency", "not 8-bit RGBA");
if (png.width !== m.frames.width * m.frames.count || png.height !== m.frames.height) {
  fail("dimensions", `${png.width}x${png.height}`);
}
// Style rules follow the declared style profile; without one, binary alpha and a palette.
const softAlpha = m.style?.alpha?.mode === "soft";
const threshold = m.style?.alpha?.threshold ?? 1;
const paletteRule = m.style === undefined || m.style.color?.rule === "palette";
if (paletteRule && !Array.isArray(m.palette)) fail("palette", "missing");
const used = new Set<string>();
let transparent = 0;
let minX = Infinity;
let minY = Infinity;
let maxX = -1;
let maxY = -1;
for (let y = 0; y < png.height; y++) {
  for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4;
    const a = png.data[i + 3] ?? 0;
    if (a === 0) {
      transparent++;
      continue;
    }
    if (a !== 255 && !softAlpha) fail("transparency", `alpha ${a} at ${x},${y}`);
    if (a < threshold) continue;
    const hex = `#${[0, 1, 2].map((k) => (png.data[i + k] ?? 0).toString(16).padStart(2, "0")).join("")}`;
    used.add(hex);
    const fx = x % m.frames.width;
    minX = Math.min(minX, fx);
    maxX = Math.max(maxX, fx);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
}
if (transparent === 0) fail("transparency", "no transparent pixel");
if (paletteRule && m.palette) {
  for (const hex of used) if (!m.palette.includes(hex)) fail("palette", `${hex} not in palette`);
  for (const hex of m.palette) if (!used.has(hex)) fail("palette", `${hex} unused`);
}
const b = m.bounds;
if (b.x !== minX || b.y !== minY || b.width !== maxX - minX + 1 || b.height !== maxY - minY + 1) {
  fail("bounds", JSON.stringify(b));
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok ${manifestPath}`);
