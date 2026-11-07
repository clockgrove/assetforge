import { decodeImage, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { postprocessFrames } from "../postprocess.ts";
import { buildVisionPrompt, combineQa, deterministicChecks, parseVisionVerdict } from "../qa.ts";
import {
  buildFramePrompt,
  buildStillPrompt,
  frameGrid,
  loadBibleInputs,
  loadReference,
  sha256,
  subjectOf,
} from "../request.ts";
import type { FrameGrid } from "../request.ts";
import type { Routes } from "../routes.ts";
import type { AssetSpec, LoadedReference, Point, TargetProfile } from "../types.ts";
import type { GeneratedCandidate, Generator, GeneratorContext } from "./generator.ts";

/** Default anchor: bottom centre of the frame, one pixel above the edge. */
function anchorOf(spec: AssetSpec, grid: FrameGrid): Point {
  return spec.anchor ?? { x: Math.floor(grid.frame.width / 2), y: grid.frame.height - 1 };
}

function asRaster(image: { mediaType: string; bytes: Uint8Array }, what: string): Raster {
  try {
    return decodeImage(image.bytes);
  } catch (error) {
    throw new Error(`${what}: could not decode the ${image.mediaType} image the model returned`, {
      cause: error,
    });
  }
}

async function finish(
  ctx: GeneratorContext,
  grid: FrameGrid,
  frames: Raster[],
  refs: LoadedReference[],
  prompt: string,
  parameters: Record<string, unknown>,
): Promise<GeneratedCandidate> {
  const { spec, bible } = ctx;
  const anchor = anchorOf(spec, grid);
  const processed = postprocessFrames(frames, {
    frame: grid.frame,
    frameCount: grid.count,
    anchor,
    palette: bible.palette,
  });
  const bytes = encodePng(processed.strip);
  const deterministic = deterministicChecks(processed.strip, {
    frame: grid.frame,
    frameCount: grid.count,
    palette: bible.palette,
  });
  const candidate: LoadedReference = {
    role: "candidate",
    path: "(candidate)",
    mediaType: "image/png",
    bytes,
    sha256: sha256(bytes),
  };
  const subject = subjectOf(spec);
  const description = bible.subjects?.[subject]?.description;
  const visionPrompt = buildVisionPrompt({
    subject,
    ...(description !== undefined && { subjectDescription: description }),
    frameCount: grid.count,
    frame: grid.frame,
    ...(spec.animationFamily !== undefined && { animationFamily: spec.animationFamily }),
    referenceRoles: refs.map((r) => r.role),
  });
  const verdict = await ctx.call.vision("vision", visionPrompt, [candidate, ...refs]);
  return {
    output: {
      mediaType: "image/png",
      extension: "png",
      bytes,
      fields: {
        frames: {
          ...grid.frame,
          count: grid.count,
          ...(grid.durationMs !== undefined && { durationMs: grid.durationMs }),
        },
        anchor,
        bounds: processed.bounds,
        palette: processed.palette,
      },
    },
    qa: combineQa(deterministic, parseVisionVerdict(verdict)),
    prompt,
    parameters: { ...parameters, frame: grid.frame, frameCount: grid.count, anchor },
  };
}

/** A still image: one text-and-reference generation, post-processed to a single frame. */
export const stillGenerator: Generator = {
  kind: "still",
  estimateCandidateUsd: (_spec: AssetSpec, _profile: TargetProfile, routes: Routes) =>
    routes.still.estimatedCostUsd + routes.vision.estimatedCostUsd,
  async generate(ctx) {
    const grid = frameGrid(
      { ...ctx.spec, frames: { ...ctx.spec.frames, count: 1 } },
      ctx.profile,
      1,
    );
    const inputs = await loadBibleInputs(ctx.spec, ctx.bible, ctx.bibleDir);
    const refs = [...inputs.subject, inputs.perspective, inputs.palette];
    const prompt = buildStillPrompt(ctx.spec, ctx.bible, grid, inputs);
    const image = await ctx.call.image("still", prompt, refs, ctx.seed);
    const qaRefs = [...inputs.subject, inputs.perspective];
    return finish(ctx, grid, [asRaster(image, "still")], qaRefs, prompt, {});
  },
};

/**
 * An animation strip. The key pose comes first: the spec's author-approved key pose when it names
 * one, otherwise a generated key pose for this candidate. Each frame is then a reference-guided
 * edit of that key pose.
 */
export const spriteStripGenerator: Generator = {
  kind: "sprite-strip",
  estimateCandidateUsd(spec, profile, routes) {
    const grid = frameGrid(spec, profile, 1);
    const keyPose = spec.keyPose ? 0 : routes.still.estimatedCostUsd;
    return keyPose + grid.count * routes.edit.estimatedCostUsd + routes.vision.estimatedCostUsd;
  },
  async generate(ctx) {
    const { spec, bible } = ctx;
    if (!spec.animationFamily) throw new Error("a sprite-strip spec needs an animationFamily");
    const grid = frameGrid(spec, ctx.profile, 1);
    const inputs = await loadBibleInputs(spec, bible, ctx.bibleDir);
    const prompt = buildStillPrompt(spec, bible, grid, inputs);
    let keyPose: LoadedReference;
    if (spec.keyPose) {
      keyPose = await loadReference(spec.keyPose, "key pose (approved)", ctx.specDir);
    } else {
      const refs = [...inputs.subject, inputs.perspective, inputs.palette];
      const image = await ctx.call.image("still", prompt, refs, ctx.seed);
      keyPose = {
        role: "key pose",
        path: "(generated key pose)",
        mediaType: image.mediaType,
        bytes: image.bytes,
        sha256: sha256(image.bytes),
      };
    }
    const frames: Raster[] = [];
    for (let i = 0; i < grid.count; i++) {
      const framePrompt = buildFramePrompt(spec, bible, grid, i);
      const image = await ctx.call.image("edit", framePrompt, [keyPose], ctx.seed + i);
      frames.push(asRaster(image, `frame ${i + 1}`));
    }
    const qaRefs = [...inputs.subject, inputs.perspective];
    return finish(ctx, grid, frames, qaRefs, prompt, {
      keyPose: { role: keyPose.role, path: keyPose.path, sha256: keyPose.sha256 },
    });
  },
};

export const imageGenerators: Generator[] = [stillGenerator, spriteStripGenerator];
