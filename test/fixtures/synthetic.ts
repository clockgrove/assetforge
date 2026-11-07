/**
 * A synthetic world for tests: a style bible whose reference images are drawn in code, a target
 * profile modelled on the public shape of Clockgrove's asset manifest, and a scripted provider
 * that "generates" opaque images of a blob on a plain background. Nothing here is private art.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedProvider } from "../../src/gateway/scripted.ts";
import type { ImageRequest } from "../../src/gateway/provider.ts";
import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import type { Raster } from "../../src/image/raster.ts";
import type { AssetSpec, StyleBible, TargetProfile } from "../../src/types.ts";

export const PALETTE = ["#26242c", "#5f6470", "#8d939e", "#c4c9d2"];
export const VALIDATOR = fileURLToPath(new URL("./validator.ts", import.meta.url));

function fill(r: Raster, rgb: [number, number, number]): void {
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) setPixel(r, x, y, [...rgb, 255]);
}

/** A grey "raccoon" blob: body, a darker mask band and a light belly, offset by `dx`. */
export function drawSubject(
  size: number,
  dx = 0,
  background: [number, number, number] = [245, 243, 238],
): Raster {
  const r = createRaster(size, size);
  fill(r, background);
  const cx = size / 2 + dx;
  const cy = size * 0.6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x - cx) / (size * 0.3);
      const ny = (y - cy) / (size * 0.22);
      if (nx * nx + ny * ny > 1) continue;
      let colour: [number, number, number] = [96, 100, 110];
      if (ny < -0.4) colour = [40, 36, 44];
      else if (ny > 0.4 && Math.abs(nx) < 0.5) colour = [190, 200, 210];
      setPixel(r, x, y, [...colour, 255]);
    }
  }
  return r;
}

export interface World {
  dir: string;
  bibleDir: string;
  bible: StyleBible;
  profile: TargetProfile;
  targetDir: string;
  runsDir: string;
}

export function syntheticProfile(overrides: Partial<TargetProfile> = {}): TargetProfile {
  return {
    name: "synthetic-grove",
    license: "MIT",
    values: { creator: "Synthetic Grove" },
    frames: { width: 32, height: 32, maxEdge: 256, durationMs: 250 },
    layout: {
      media: "assets/source/{{spec.assetId}}/{{spec.animationFamily}}.{{output.extension}}",
      manifest: "assets/manifests/{{spec.assetId}}/{{spec.animationFamily}}.json",
    },
    manifest: {
      assetManifestVersion: 1,
      assetId: "{{spec.assetId}}",
      animationFamily: "{{spec.animationFamily}}",
      source: {
        kind: "generated",
        path: "{{output.path}}",
        mediaType: "{{output.mediaType}}",
        creator: "{{profile.creator}}",
        tool: "assetforge",
      },
      license: "{{profile.license}}",
      provenance: {
        prompt: "{{provenance.prompt}}",
        references: "{{provenance.referenceHashes}}",
        generated: "{{provenance}}",
      },
      review: { status: "pending" },
      semantic: "{{spec.fields.semantic?}}",
      frames: "{{output.frames}}",
      anchor: "{{output.anchor}}",
      bounds: "{{output.bounds}}",
      palette: "{{output.palette}}",
      contentHash: "{{output.sha256}}",
      accessibilityLabel: "{{spec.fields.accessibilityLabel?}}",
    },
    review: { path: "review.status", pending: "pending" },
    validator: { command: [process.execPath, VALIDATOR, "{{manifest}}"] },
    ...overrides,
  };
}

export async function syntheticWorld(): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), "assetforge-"));
  const bibleDir = join(dir, "bible");
  await mkdir(join(bibleDir, "refs"), { recursive: true });
  await writeFile(join(bibleDir, "refs/stevie-sheet.png"), encodePng(drawSubject(48)));
  await writeFile(join(bibleDir, "refs/stevie-turnaround.png"), encodePng(drawSubject(48, 4)));
  await writeFile(join(bibleDir, "refs/den.png"), encodePng(drawSubject(48, -2)));
  await writeFile(
    join(bibleDir, "refs/perspective.png"),
    encodePng(drawSubject(48, 0, [200, 220, 200])),
  );
  const bible: StyleBible = {
    version: "synthetic-1",
    palette: PALETTE,
    references: [
      { path: "refs/stevie-sheet.png", role: "character sheet", subject: "stevie" },
      { path: "refs/stevie-turnaround.png", role: "turnaround", subject: "stevie" },
      { path: "refs/den.png", role: "prop", subject: "den" },
      { path: "refs/perspective.png", role: "perspective" },
    ],
    perspective: "refs/perspective.png",
    subjects: {
      stevie: { description: "a grey adult raccoon with a dark mask" },
      den: { description: "a wooden raccoon den" },
    },
    mood: ["quiet", "storybook realism"],
  };
  // An author-approved key pose beside the spec, which shelterSpec names.
  await writeFile(join(dir, "key-pose.png"), encodePng(drawSubject(96, 3)));
  const targetDir = join(dir, "target");
  await mkdir(targetDir);
  return {
    dir,
    bibleDir,
    bible,
    profile: syntheticProfile(),
    targetDir,
    runsDir: join(dir, "runs"),
  };
}

export const shelterSpec: AssetSpec = {
  kind: "sprite-strip",
  assetId: "stevie",
  animationFamily: "shelter",
  frames: { count: 6 },
  anchor: { x: 16, y: 30 },
  keyPose: "key-pose.png",
  fields: {
    semantic: { role: "actor", entity: "grove.stevie" },
    accessibilityLabel: "Stevie sheltering",
  },
};

export interface ScriptOptions {
  /** Candidate indices (zero-based) whose vision verdict fails identity. */
  failIdentity?: number[];
  imageCostUsd?: number;
  visionCostUsd?: number;
}

/** The frame number an edit prompt asks for, so scripted frames differ. */
function frameOf(request: ImageRequest): number {
  const m = /frame (\d+) of/.exec(request.prompt);
  return m?.[1] ? Number(m[1]) : 0;
}

export function scriptedProvider(options: ScriptOptions = {}): ScriptedProvider {
  return new ScriptedProvider({
    image: (request) => ({
      images: [{ mediaType: "image/png", bytes: encodePng(drawSubject(96, frameOf(request))) }],
      ...(options.imageCostUsd !== undefined && { costUsd: options.imageCostUsd }),
      ...(request.seed !== undefined && { seed: request.seed }),
    }),
    vision: (_request, index) => {
      const identity = !(options.failIdentity ?? []).includes(index);
      return {
        text:
          "```json\n" +
          JSON.stringify({
            checks: [
              {
                check: "transparency",
                passed: true,
                reason: "the background is fully transparent",
              },
              {
                check: "frame-count",
                passed: true,
                reason: "the frames are distinct and in their cells",
              },
              {
                check: "identity",
                passed: identity,
                reason: identity
                  ? "same grey raccoon with a dark mask as the sheet"
                  : "a different animal",
              },
              {
                check: "perspective",
                passed: true,
                reason: "three-quarter view matches the sample",
              },
            ],
          }) +
          "\n```",
        ...(options.visionCostUsd !== undefined && { costUsd: options.visionCostUsd }),
      };
    },
  });
}
