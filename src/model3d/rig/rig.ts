/**
 * The shared rig end to end on one character: fit the target's skeleton template to the mesh, skin
 * it, generate the clips its gait profiles declare, write the re-rigged `.glb`, and check every
 * clip and render it for the person. No provider call is made.
 */
import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createRaster, decodeImage, encodePng } from "../../image/raster.ts";
import type { Raster } from "../../image/raster.ts";
import { resampleTo } from "../../image/resample.ts";
import type { Reason } from "../../types.ts";
import { parseGlb, writeGlb } from "../glb.ts";
import type { Glb } from "../glb.ts";
import { renderView } from "../render.ts";
import { boundsOf, posedPrimitives, samplePose } from "../scene.ts";
import { buildRiggedGlb } from "./build.ts";
import { bakeMesh, fitSkeleton, skinWeights, soleEnds, soles } from "./fit.ts";
import { generateGait } from "./gait.ts";
import type { GeneratedClip } from "./gait.ts";
import {
  comparisonCheck,
  contactCheck,
  jointLimitCheck,
  qaSampleCount,
  sampleClip,
  sampleSourceClip,
  skinningCheck,
} from "./qa.ts";
import type { LoadedRig } from "./template.ts";

/** Side-view frames rendered per generated clip, and in its comparison with the reference. */
export const SIDE_FRAMES = 8;

export interface RiggedCharacter {
  /** The written `.glb` (parsed back). */
  glb: Glb;
  bytes: Uint8Array;
  clips: GeneratedClip[];
  /** Requested families the profile declares no gait for: reported, never faked. */
  missing: Array<{ family: string; why: string }>;
  /** contact, joint-limits and skinning per clip. */
  reasons: Reason[];
  /** Side-view walk frames and the side-by-side with the reference frames, for the person. */
  artifacts: Array<{ name: string; bytes: Uint8Array }>;
  /** Fitted joints, in body lengths moved from the template. */
  fit: { bodyLengthM: number; joints: number; maxMovedBodyLengths: number };
}

export async function rigCharacter(options: {
  /** The normalised model: facing the profile's forward, standing on y = 0. */
  source: Glb;
  /** Yaw in radians from +z to the profile's forward. */
  yaw: number;
  rig: LoadedRig;
  families: string[];
  sizePx: number;
}): Promise<RiggedCharacter> {
  const { rig } = options;
  const mesh = bakeMesh(options.source, options.yaw);
  const skeleton = fitSkeleton(rig.template, mesh);
  const skin = skinWeights(skeleton, mesh);
  const sole = soles(skeleton, mesh, skin);
  const ends = soleEnds(skeleton, mesh, sole);
  const clips: GeneratedClip[] = [];
  const missing: RiggedCharacter["missing"] = [];
  for (const family of options.families) {
    const gait = rig.gaits[family];
    if (gait) clips.push(generateGait(family, gait, skeleton, mesh, sole, skin));
    else {
      missing.push({
        family,
        why: `the target declares no gait profile for "${family}" (model3d.gaits.${family})`,
      });
    }
  }
  const bytes = writeGlb(buildRiggedGlb(options.source, mesh, skeleton, skin, clips));
  const glb = parseGlb(bytes);

  const reasons: Reason[] = [];
  clips.forEach((clip, index) => {
    const samples = sampleClip(
      glb,
      index,
      clip,
      skeleton,
      options.yaw,
      qaSampleCount(clip.dutyFactor),
    );
    reasons.push(
      contactCheck(clip.family, samples, clip, skeleton, sole, ends, rig.qa),
      jointLimitCheck(clip.family, samples, clip, skeleton),
      skinningCheck(clip.family, samples, skeleton, mesh, skin, rig.qa),
    );
    // When the source carries its own clip of this family (a provider's library walk), the
    // person also gets both measured the same way, so what the generated clip fixed is recorded.
    const before = sampleSourceClip(options.source, clip.family, options.yaw);
    if (before) {
      const after = samples.map((s) => s.vertices);
      reasons.push(comparisonCheck(clip.family, before, after, skeleton, sole, ends, rig.qa));
    }
  });

  const artifacts: RiggedCharacter["artifacts"] = [];
  const framing = boundsOf(posedPrimitives(glb));
  if (framing) {
    const sideYaw = (options.yaw * 180) / Math.PI + 90;
    for (const [index, clip] of clips.entries()) {
      const frames: Raster[] = [];
      for (let i = 0; i < SIDE_FRAMES; i++) {
        const raster = renderView(glb, {
          sizePx: options.sizePx,
          yawDeg: sideYaw,
          pose: samplePose(glb, index, (i * clip.durationS) / SIDE_FRAMES),
          framing,
        });
        frames.push(raster);
      }
      artifacts.push({ name: `${clip.family}-side.png`, bytes: encodePng(row(frames)) });
      const referenceDir = rig.gaits[clip.family]?.reference;
      if (referenceDir !== undefined) {
        const references = await referenceFrames(resolve(rig.baseDir, referenceDir));
        if (references.frames.length > 0) {
          const scaled = references.frames.map((r) => toHeight(r, options.sizePx));
          artifacts.push({
            name: `${clip.family}-vs-reference.png`,
            bytes: encodePng(column([row(frames), row(scaled)])),
          });
        } else {
          // A declared reference that yields nothing is not silently skipped: the person would
          // get no comparison and nothing saying why.
          reasons.push({
            check: `reference-${clip.family}`,
            passed: false,
            reason: `model3d.gaits.${clip.family}.reference "${referenceDir}" ${references.problem}, so ${clip.family}-vs-reference.png could not be made`,
            source: "deterministic",
          });
        }
      }
    }
  }

  return {
    glb,
    bytes,
    clips,
    missing,
    reasons,
    artifacts,
    fit: {
      bodyLengthM: skeleton.bodyLength,
      joints: skeleton.names.length,
      maxMovedBodyLengths: Math.max(...skeleton.moved),
    },
  };
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

/**
 * The reference frames in a directory: PNG and JPEG files, by name. When there are none, `problem`
 * says why (the directory cannot be read, holds no image, or none of its images decodes).
 */
export async function referenceFrames(
  dir: string,
): Promise<{ frames: Raster[]; problem?: string }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { frames: [], problem: `cannot be read (${code ?? "unreadable"})` };
  }
  const images = names.filter((n) => IMAGE_EXTENSIONS.has(extname(n).toLowerCase())).sort();
  if (images.length === 0) return { frames: [], problem: "holds no PNG or JPEG frame" };
  const frames: Raster[] = [];
  const undecodable: string[] = [];
  for (const name of images) {
    try {
      frames.push(decodeImage(new Uint8Array(await readFile(join(dir, name)))));
    } catch {
      undecodable.push(name);
    }
  }
  return frames.length > 0
    ? { frames }
    : { frames, problem: `holds no frame that decodes (${undecodable.join(", ")})` };
}

function toHeight(src: Raster, height: number): Raster {
  const s = height / src.height;
  const width = Math.max(1, Math.round(src.width * s));
  const out = resampleTo(src, s, { x: 0, y: 0 }, { width, height }, "antialiased");
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  return out;
}

const BACKGROUND = 0xd8;

function row(images: Raster[]): Raster {
  const height = Math.max(...images.map((r) => r.height));
  const width = images.reduce((sum, r) => sum + r.width, 0);
  const out = createRaster(width, height);
  out.data.fill(BACKGROUND);
  let x0 = 0;
  for (const image of images) {
    for (let y = 0; y < image.height; y++) {
      out.data.set(
        image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
        (y * width + x0) * 4,
      );
    }
    x0 += image.width;
  }
  return out;
}

function column(images: Raster[]): Raster {
  const width = Math.max(...images.map((r) => r.width));
  const height = images.reduce((sum, r) => sum + r.height, 0);
  const out = createRaster(width, height);
  out.data.fill(BACKGROUND);
  let y0 = 0;
  for (const image of images) {
    for (let y = 0; y < image.height; y++) {
      out.data.set(
        image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
        (y0 + y) * width * 4,
      );
    }
    y0 += image.height;
  }
  return out;
}
