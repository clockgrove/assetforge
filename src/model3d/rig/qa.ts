/**
 * QA of a generated clip, measured on the written file's deformed mesh before a person sees it:
 * foot contact (on the ground line, not sliding, plantigrade heels down), joint limits by gait
 * phase, and skinning (no collapsed girth at bent leg joints).
 */
import type { Reason } from "../../types.ts";
import type { Glb } from "../glb.ts";
import { clips as clipsOf, posedPrimitives, samplePose, worldMatrices } from "../scene.ts";
import type { BakedMesh, Skeleton, SkinWeights } from "./fit.ts";
import { dominantJoint } from "./fit.ts";
import { inSpan } from "./gait.ts";
import type { GeneratedClip } from "./gait.ts";
import { jointNode } from "./build.ts";
import { QUAT_IDENTITY, add, dot, eulerXyzDeg, length, rotY, rotate, scale, sub } from "./math.ts";
import type { Quat, V3 } from "./math.ts";
import type { JointLimits, RigQaTolerances } from "./template.ts";

export const QA_SAMPLES = 24;
/** Frames this close to touchdown or lift-off (as a fraction of the cycle) are not stance-checked. */
const STANCE_MARGIN = 0.03;
const LIMIT_SLACK_DEG = 0.5;

const deterministic = (check: string, passed: boolean, reason: string): Reason => ({
  check,
  passed,
  reason,
  source: "deterministic",
});

export interface ClipSample {
  timeS: number;
  /** The cycle phase, 0..1. */
  phase: number;
  /** Deformed vertices in the facing frame, in baked-mesh order. */
  vertices: Float64Array;
  /** Joint world positions in the facing frame. */
  joints: V3[];
  /** Joint local rotations. */
  local: Quat[];
}

/** Samples the clip as written in the file: deformed vertices and joints, in the facing frame. */
export function sampleClip(
  glb: Glb,
  clipIndex: number,
  clip: GeneratedClip,
  skeleton: Skeleton,
  yaw: number,
  samples = QA_SAMPLES,
): ClipSample[] {
  const back = rotY(-yaw);
  const out: ClipSample[] = [];
  for (let k = 0; k < samples; k++) {
    const phase = k / samples;
    const timeS = phase * clip.durationS;
    const pose = samplePose(glb, clipIndex, timeS);
    const vertices = facingVertices(glb, pose, yaw);
    const world = worldMatrices(glb.json, pose);
    const joints = skeleton.names.map((_, j) => {
      const m = world.get(jointNode(j))!;
      return rotate(back, [m[12]!, m[13]!, m[14]!]);
    });
    const local = skeleton.names.map(
      (_, j) => (pose.get(jointNode(j))?.r as Quat | undefined) ?? QUAT_IDENTITY,
    );
    out.push({ timeS, phase, vertices, joints, local });
  }
  return out;
}

const fmt = (v: number, digits = 4) => v.toFixed(digits);

/** Deformed vertices in the facing frame, in baked-mesh order, for one pose of a model. */
function facingVertices(glb: Glb, pose: ReturnType<typeof samplePose>, yaw: number): Float64Array {
  const back = rotY(-yaw);
  const prims = posedPrimitives(glb, pose);
  const count = prims.reduce((n, p) => n + p.positions.length / 3, 0);
  const vertices = new Float64Array(count * 3);
  let at = 0;
  for (const p of prims) {
    for (let i = 0; i < p.positions.length; i += 3) {
      vertices.set(rotate(back, [p.positions[i]!, p.positions[i + 1]!, p.positions[i + 2]!]), at);
      at += 3;
    }
  }
  return vertices;
}

/**
 * The source model's own clip of a family (a provider's library walk, say), as deformed vertices
 * over one cycle in baked-mesh order; undefined when the source has no clip of that name.
 */
export function sampleSourceClip(
  source: Glb,
  family: string,
  yaw: number,
  samples = QA_SAMPLES,
): Float64Array[] | undefined {
  const clip = clipsOf(source).find((c) => c.name === family);
  if (!clip || !(clip.durationS > 0)) return undefined;
  return Array.from({ length: samples }, (_, k) =>
    facingVertices(source, samplePose(source, clip.index, (k / samples) * clip.durationS), yaw),
  );
}

/** A foot measured on fewer stance frames than this is not measured: it fails. */
export const MIN_STANCE_SAMPLES = 2;

/** Frames per cycle so every foot has at least four stance frames inside the margins. */
export function qaSampleCount(dutyFactor: number): number {
  const window = dutyFactor - 2 * STANCE_MARGIN;
  return window > 0 ? Math.max(QA_SAMPLES, Math.ceil(4 / window)) : QA_SAMPLES;
}

/**
 * Stance feet on the ground line within tolerance, not sliding, and plantigrade heels down. The
 * heel is measured on the deformed mesh: the lowest vertex of the sole's heel end above the lowest
 * of its toe end (`ends`, from `soleEnds`), so a mesh heel that stays up is seen even when the
 * joints are level.
 */
export function contactCheck(
  family: string,
  samples: ClipSample[],
  clip: GeneratedClip,
  skeleton: Skeleton,
  soleVertices: number[][],
  ends: Array<{ heel: number[]; toe: number[]; restRise: number }>,
  tolerances: RigQaTolerances,
): Reason {
  const L = skeleton.bodyLength;
  const failures: string[] = [];
  const summary: string[] = [];
  skeleton.feet.forEach((foot, f) => {
    const sole = soleVertices[f]!;
    if (sole.length === 0) {
      failures.push(`${foot.name} has no skin under its foot to measure`);
      return;
    }
    const { heel, toe } = ends[f]!;
    if (foot.plantigrade && (heel.length === 0 || toe.length === 0)) {
      failures.push(`${foot.name} is plantigrade but its sole has no heel and toe end to measure`);
      return;
    }
    const lowestY = (s: ClipSample, vertices: number[]) => {
      let y = Infinity;
      for (const v of vertices) y = Math.min(y, s.vertices[v * 3 + 1]!);
      return y;
    };
    if (clip.contacts[f]!.length === 0) {
      summary.push(`${foot.name} never down`);
      return;
    }
    let worstGround = 0;
    let worstHeel = -Infinity;
    let slide = 0;
    for (const span of clip.contacts[f]!) {
      const ground: Array<[number, number]> = [];
      for (const s of samples) {
        const { p, inside } = inSpan(s.phase, span);
        if (!inside || p < STANCE_MARGIN || p > span.length - STANCE_MARGIN) continue;
        let minY = Infinity;
        let cx = 0;
        let cz = 0;
        for (const v of sole) {
          minY = Math.min(minY, s.vertices[v * 3 + 1]!);
          cx += s.vertices[v * 3]!;
          cz += s.vertices[v * 3 + 2]!;
        }
        if (Math.abs(minY) > Math.abs(worstGround)) worstGround = minY;
        // In the ground frame the in-place clip moves forward at its speed since touchdown.
        ground.push([cx / sole.length, cz / sole.length + clip.speedMps * p * clip.durationS]);
        if (foot.plantigrade) worstHeel = Math.max(worstHeel, lowestY(s, heel) - lowestY(s, toe));
      }
      if (ground.length < MIN_STANCE_SAMPLES) {
        failures.push(
          `${foot.name} has ${ground.length} stance frame${ground.length === 1 ? "" : "s"} to measure ` +
            `of ${samples.length} (needs ${MIN_STANCE_SAMPLES}): sample the clip more densely`,
        );
        return;
      }
      for (const a of ground) {
        for (const b of ground) slide = Math.max(slide, Math.hypot(a[0] - b[0], a[1] - b[1]));
      }
    }
    const groundOk = Math.abs(worstGround) <= tolerances.contactBodyLengths * L;
    const slideOk = slide <= tolerances.slideBodyLengths * L;
    const heelOk = !foot.plantigrade || worstHeel <= tolerances.heelBodyLengths * L;
    summary.push(
      `${foot.name} sole ${fmt(worstGround)} m from the ground, slides ${fmt(slide)} m` +
        (foot.plantigrade
          ? `, heel ${fmt(worstHeel)} m above toe (${fmt(ends[f]!.restRise)} m at rest)`
          : ""),
    );
    if (!groundOk) {
      failures.push(
        `${foot.name} stance sole ${worstGround > 0 ? "floats" : "sinks"} ${fmt(Math.abs(worstGround))} m ` +
          `(tolerance ${fmt(tolerances.contactBodyLengths * L)} m)`,
      );
    }
    if (!slideOk) {
      failures.push(
        `${foot.name} slides ${fmt(slide)} m in stance (tolerance ${fmt(tolerances.slideBodyLengths * L)} m)`,
      );
    }
    if (!heelOk) {
      failures.push(
        `${foot.name} is plantigrade but its heel stays ${fmt(worstHeel)} m above its toe in stance ` +
          `(tolerance ${fmt(tolerances.heelBodyLengths * L)} m)`,
      );
    }
  });
  return deterministic(
    `contact-${family}`,
    failures.length === 0,
    failures.length === 0
      ? `stance feet planted on the ground line: ${summary.join("; ")}`
      : failures.join("; "),
  );
}

interface DownFoot {
  /** Mean height of the foot's lowest sole point on the frames it is down. */
  ground: number;
  /** Heel end above toe end on those frames, mean and worst (plantigrade feet only). */
  heel?: { mean: number; max: number };
}

/**
 * Each foot on the frames it is down (its sole's lowest point within `contact` of its lowest over
 * the cycle), measured on the deformed sole. Needs no footfall, so a clip from elsewhere (a
 * provider's library walk) is measured the same way as a generated one.
 */
function downFeet(
  frames: Float64Array[],
  skeleton: Skeleton,
  soleVertices: number[][],
  ends: Array<{ heel: number[]; toe: number[] }>,
  contact: number,
): Array<DownFoot | undefined> {
  const lowestY = (vertices: Float64Array, vs: number[]) => {
    let y = Infinity;
    for (const v of vs) y = Math.min(y, vertices[v * 3 + 1]!);
    return y;
  };
  return skeleton.feet.map((foot, f) => {
    const sole = soleVertices[f]!;
    if (sole.length === 0 || frames.length === 0) return undefined;
    const lows = frames.map((vertices) => lowestY(vertices, sole));
    const floor = Math.min(...lows);
    const down = frames.filter((_, k) => lows[k]! <= floor + contact);
    const ground = down.reduce((sum, vertices) => sum + lowestY(vertices, sole), 0) / down.length;
    const { heel, toe } = ends[f]!;
    if (!foot.plantigrade || heel.length === 0 || toe.length === 0) return { ground };
    const rises = down.map((vertices) => lowestY(vertices, heel) - lowestY(vertices, toe));
    return {
      ground,
      heel: { mean: rises.reduce((a, b) => a + b, 0) / rises.length, max: Math.max(...rises) },
    };
  });
}

/**
 * The source's own clip beside the generated one, measured the same way on the deformed sole:
 * the spread of the feet's ground lines, and each plantigrade foot's heel above its toe while
 * down. Recorded for the person beside QA (shadow), never used to filter: it shows what the
 * generated clip changed.
 */
export function comparisonCheck(
  family: string,
  sourceFrames: Float64Array[],
  generatedFrames: Float64Array[],
  skeleton: Skeleton,
  soleVertices: number[][],
  ends: Array<{ heel: number[]; toe: number[] }>,
  tolerances: RigQaTolerances,
): Reason {
  const contact = tolerances.contactBodyLengths * skeleton.bodyLength;
  const before = downFeet(sourceFrames, skeleton, soleVertices, ends, contact);
  const after = downFeet(generatedFrames, skeleton, soleVertices, ends, contact);
  const spread = (feet: Array<DownFoot | undefined>) => {
    const g = feet.flatMap((d) => (d ? [d.ground] : []));
    return g.length ? Math.max(...g) - Math.min(...g) : 0;
  };
  const parts = [`ground-line spread ${fmt(spread(before))} → ${fmt(spread(after))} m`];
  skeleton.feet.forEach((foot, f) => {
    const b = before[f]?.heel;
    const a = after[f]?.heel;
    if (b && a) {
      parts.push(
        `${foot.name} heel above toe while down ${fmt(b.mean)} (worst ${fmt(b.max)}) → ` +
          `${fmt(a.mean)} (worst ${fmt(a.max)}) m`,
      );
    }
  });
  return {
    check: `compare-${family}`,
    passed: true,
    reason: `the source's own "${family}" → the generated one, on the deformed sole: ${parts.join("; ")}`,
    source: "deterministic",
    shadow: true,
  };
}

/** The axis furthest outside its range, and by how many degrees; undefined when all are within. */
function outside(
  angles: V3,
  limits: JointLimits | undefined,
): { excess: number; text: string } | undefined {
  if (!limits) return undefined;
  const axes = ["x", "y", "z"] as const;
  let worst: { excess: number; text: string } | undefined;
  for (let i = 0; i < 3; i++) {
    const range = limits[axes[i]!];
    if (!range) continue;
    const a = angles[i]!;
    const excess = Math.max(range[0] - a, a - range[1]);
    if (excess > LIMIT_SLACK_DEG && (!worst || excess > worst.excess)) {
      worst = { excess, text: `${axes[i]} ${a.toFixed(1)}° outside [${range[0]}, ${range[1]}]` };
    }
  }
  return worst;
}

/**
 * No joint outside the template's range; a weight-bearing ankle or wrist also within its stance
 * range while its foot is down. In the swing only the full range applies, so a wrist may curl.
 * Each failing joint is reported at its worst frame.
 */
export function jointLimitCheck(
  family: string,
  samples: ClipSample[],
  clip: GeneratedClip,
  skeleton: Skeleton,
): Reason {
  const worst = new Map<number, { excess: number; text: string }>();
  const stanceAnkle = new Map<number, number>();
  skeleton.feet.forEach((foot, f) => stanceAnkle.set(foot.chain[2], f));
  for (const s of samples) {
    skeleton.template.joints.forEach((joint, j) => {
      const angles = eulerXyzDeg(s.local[j]!);
      let problem = outside(angles, joint.limits);
      let phaseName = "any phase";
      const f = stanceAnkle.get(j);
      if (!problem && f !== undefined && joint.stanceLimits) {
        if (clip.contacts[f]!.some((span) => inSpan(s.phase, span).inside)) {
          problem = outside(angles, joint.stanceLimits);
          phaseName = "stance";
        }
      }
      if (problem && problem.excess > (worst.get(j)?.excess ?? 0)) {
        worst.set(j, {
          excess: problem.excess,
          text: `${joint.name} in ${phaseName} at ${s.timeS.toFixed(2)} s: ${problem.text}`,
        });
      }
    });
  }
  const violations = [...worst.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.text);
  return deterministic(
    `joint-limits-${family}`,
    violations.length === 0,
    violations.length === 0
      ? `every joint within the template's range (stance range for weight-bearing ankles and wrists) over ${samples.length} frames`
      : violations.slice(0, 6).join("; "),
  );
}

function segmentDistance(p: V3, a: V3, b: V3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return length(sub(p, add(a, scale(ab, t))));
}

/**
 * Girth at each bent leg joint (knee or elbow, ankle or wrist): the mean distance of the skin
 * around the joint from its two bones, deformed over rest. A ratio under the tolerance is volume
 * collapsing where the joint bends.
 */
export function skinningCheck(
  family: string,
  samples: ClipSample[],
  skeleton: Skeleton,
  mesh: BakedMesh,
  skin: SkinWeights,
  tolerances: RigQaTolerances,
): Reason {
  const results: Array<{ name: string; ratio: number; timeS: number }> = [];
  const P = skeleton.rest;
  for (const foot of skeleton.feet) {
    for (const k of [1, 2] as const) {
      const j = foot.chain[k];
      const parent = foot.chain[k - 1]!;
      const child = foot.chain[k + 1]!;
      const radius = 0.6 * Math.min(length(sub(P[j]!, P[parent]!)), length(sub(P[child]!, P[j]!)));
      const near: number[] = [];
      for (let v = 0; v < mesh.count; v++) {
        const d = dominantJoint(skin, v);
        if (d !== j && d !== parent) continue;
        const q: V3 = [mesh.facing[v * 3]!, mesh.facing[v * 3 + 1]!, mesh.facing[v * 3 + 2]!];
        if (length(sub(q, P[j]!)) <= radius) near.push(v);
      }
      if (near.length < 6) continue;
      const girth = (vertices: Float64Array, a: V3, b: V3, c: V3) => {
        let sum = 0;
        for (const v of near) {
          const q: V3 = [vertices[v * 3]!, vertices[v * 3 + 1]!, vertices[v * 3 + 2]!];
          sum += Math.min(segmentDistance(q, a, b), segmentDistance(q, b, c));
        }
        return sum / near.length;
      };
      const rest = girth(mesh.facing, P[parent]!, P[j]!, P[child]!);
      if (!(rest > 0)) continue;
      let worst = { ratio: Infinity, timeS: 0 };
      for (const s of samples) {
        const ratio = girth(s.vertices, s.joints[parent]!, s.joints[j]!, s.joints[child]!) / rest;
        if (ratio < worst.ratio) worst = { ratio, timeS: s.timeS };
      }
      results.push({ name: skeleton.names[j]!, ...worst });
    }
  }
  const failing = results.filter((r) => r.ratio < tolerances.minGirthRatio);
  const describe = (r: (typeof results)[number]) =>
    `${r.name} ${(r.ratio * 100).toFixed(0)}% at ${r.timeS.toFixed(2)} s`;
  if (results.length === 0) {
    return deterministic(
      `skinning-${family}`,
      false,
      "no skin found around the leg joints to measure",
    );
  }
  return deterministic(
    `skinning-${family}`,
    failing.length === 0,
    failing.length === 0
      ? `girth at bent leg joints kept at ${(Math.min(...results.map((r) => r.ratio)) * 100).toFixed(0)}% of rest or more (minimum ${(tolerances.minGirthRatio * 100).toFixed(0)}%)`
      : `volume collapses at ${failing.map(describe).join(", ")} (minimum ${(tolerances.minGirthRatio * 100).toFixed(0)}% of rest girth)`,
  );
}
