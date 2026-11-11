/**
 * Generated locomotion: a looping, in-place clip on the fitted skeleton from a gait profile. The
 * body carries the profile's back arch, hip height, head and tail; each leg is solved by two-bone
 * inverse kinematics so its foot is planted on the ground line through its stance (flat, for a
 * plantigrade foot) and swings forward, curling, through the rest. Deterministic: no randomness and
 * no provider call.
 */
import type { BakedMesh, Skeleton } from "./fit.ts";
import { bendNormal, topological } from "./fit.ts";
import {
  QUAT_IDENTITY,
  add,
  cross,
  dot,
  frameRotation,
  length,
  normalize,
  quatConj,
  quatMul,
  rad,
  rotX,
  rotY,
  rotate,
  sameHemisphere,
  scale,
  sub,
} from "./math.ts";
import type { Quat, V3 } from "./math.ts";
import type { GaitProfile } from "./template.ts";

export const FRAMES_PER_SECOND = 30;
const MIN_FRAMES = 24;

export interface GeneratedClip {
  family: string;
  durationS: number;
  loop: boolean;
  /** The ground speed that keeps stance feet planted, metres per second. */
  speedMps: number;
  /** Key times, seconds; the last equals durationS. */
  times: number[];
  /** Per key, every joint's local rotation. */
  rotations: Quat[][];
  /** Per key, the root joint's local translation. */
  rootTranslation: V3[];
  /** Per foot (template order), the phase at which it touches down, as a fraction of the cycle. */
  touchdown: number[];
  dutyFactor: number;
}

/** A foot's phase from touchdown, 0..1: stance is [0, dutyFactor). */
export function footPhase(cyclePhase: number, touchdown: number): number {
  const p = (cyclePhase - touchdown) % 1;
  return p < 0 ? p + 1 : p;
}

export interface Fk {
  rotation: Quat[];
  position: V3[];
}

/** World rotations and positions (facing frame) from local rotations and the root's offset. */
export function forwardKinematics(skeleton: Skeleton, local: Quat[], rootOffset: V3): Fk {
  const rotation: Quat[] = [];
  const position: V3[] = [];
  for (const j of topological(skeleton.parent)) {
    const p = skeleton.parent[j]!;
    if (p < 0) {
      rotation[j] = local[j]!;
      position[j] = add(skeleton.rest[j]!, rootOffset);
    } else {
      rotation[j] = quatMul(rotation[p]!, local[j]!);
      position[j] = add(
        position[p]!,
        rotate(rotation[p]!, sub(skeleton.rest[j]!, skeleton.rest[p]!)),
      );
    }
  }
  return { rotation, position };
}

function byRole(skeleton: Skeleton, role: string): number[] {
  return skeleton.template.joints.flatMap((j, i) => (j.role === role ? [i] : []));
}

/**
 * Generates one clip. `soleVertices` are each foot's sole vertices (indices into the baked mesh),
 * so the foot is lowered until its sole, not its joint, meets the ground.
 */
export function generateGait(
  family: string,
  gait: GaitProfile,
  skeleton: Skeleton,
  mesh: BakedMesh,
  soleVertices: number[][],
): GeneratedClip {
  const L = skeleton.bodyLength;
  const stride = gait.strideBodyLengths * L;
  const speed = gait.speedBodyLengthsPerSecond * L;
  const durationS = stride / speed;
  const frames = Math.max(MIN_FRAMES, Math.round(durationS * FRAMES_PER_SECOND));
  const duty = gait.dutyFactor;
  const lift = gait.stepHeightBodyLengths * L;
  const sweep = stride * duty;

  const order = new Map(gait.footfall.map((name, i) => [name, i / gait.footfall.length]));
  const touchdown = skeleton.feet.map((f) => order.get(f.name) ?? 0);
  const hindLead = skeleton.feet.findIndex((f) => f.pair === "hind");
  const swayPhase = hindLead >= 0 ? touchdown[hindLead]! : 0;

  const root = skeleton.parent.indexOf(-1);
  const spine = byRole(skeleton, "spine");
  const head = [...byRole(skeleton, "neck"), ...byRole(skeleton, "head")];
  const tail = byRole(skeleton, "tail");
  const hipSway = gait.hipSwayDeg ?? gait.tailSwayDeg / 3;

  // Per foot: rest geometry and the sole relative to the ankle.
  const feet = skeleton.feet.map((foot, f) => {
    const [u, l, a, t] = foot.chain;
    const P = skeleton.rest;
    const toeDir = sub(P[t]!, P[a]!);
    // Plantigrade feet stand flat: the ankle-to-toe line turned level about the lateral axis.
    const pitch =
      foot.plantigrade && toeDir[2] > 1e-9 ? Math.atan2(toeDir[1], Math.hypot(toeDir[2])) : 0;
    const base = foot.plantigrade ? rotX(pitch) : QUAT_IDENTITY;
    const fallbackKnee: V3 = foot.pair === "hind" ? [0, 0, 1] : [0, 0, -1];
    const bend = bendNormal(skeleton, foot.chain, fallbackKnee);
    const sole = soleVertices[f]!.map(
      (v) =>
        sub([mesh.facing[v * 3]!, mesh.facing[v * 3 + 1]!, mesh.facing[v * 3 + 2]!], P[a]!) as V3,
    );
    return {
      foot,
      u,
      l,
      a,
      upper: length(sub(P[l]!, P[u]!)),
      lower: length(sub(P[a]!, P[l]!)),
      base,
      bend,
      sole: sole.length > 0 ? sole : [sub(P[t]!, P[a]!)],
      curl: rad(
        foot.pair === "fore" ? (gait.swingCurlDeg?.fore ?? 0) : (gait.swingCurlDeg?.hind ?? 0),
      ),
      restAnkle: P[a]!,
    };
  });

  // The body's pose apart from the gait's oscillation: arch, head, tail, and the root's height
  // offset and extra pitch that let every leg reach the ground with its foot planted.
  const bodyPose = (sway: number, pitchExtra: number): Quat[] => {
    const local: Quat[] = skeleton.names.map(() => QUAT_IDENTITY);
    const rootPitch = rad(-gait.backArchDeg / 2) + pitchExtra;
    local[root] = quatMul(rotY(rad(hipSway * sway)), rotX(rootPitch));
    for (const j of spine) {
      local[j] = quatMul(
        rotX(rad(gait.backArchDeg / spine.length)),
        rotY(rad((-hipSway * sway) / spine.length)),
      );
    }
    for (const j of head) local[j] = rotX(rad(gait.headPitchDeg / head.length));
    tail.forEach((j, i) => {
      // The first tail joint undoes the root's pitch, so tail carriage is measured from level.
      const level = i === 0 ? -rootPitch : 0;
      local[j] = quatMul(
        rotY(rad((gait.tailSwayDeg * sway) / tail.length)),
        rotX(rad(gait.tailPitchDeg / tail.length) + level),
      );
    });
    return local;
  };
  const { rootY, pitchExtra } = stance(skeleton, feet, sweep, gait.hipHeightRatio, bodyPose);

  const times: number[] = [];
  const rotations: Quat[][] = [];
  const rootTranslation: V3[] = [];
  for (let k = 0; k <= frames; k++) {
    const phase = (k % frames) / frames;
    times.push((k / frames) * durationS);
    const sway = Math.sin(2 * Math.PI * (phase - swayPhase));
    const local = bodyPose(sway, pitchExtra);
    const bob = -0.15 * lift * Math.cos(4 * Math.PI * (phase - swayPhase));
    const offset: V3 = [0, rootY + bob, 0];
    const body = forwardKinematics(skeleton, local, offset);

    feet.forEach((leg, f) => {
      const p = footPhase(phase, touchdown[f]!);
      let dz: number;
      let up = 0;
      let curl = 0;
      if (p < duty) {
        dz = sweep / 2 - sweep * (p / duty);
      } else {
        const s = (p - duty) / (1 - duty);
        dz = -sweep / 2 + sweep * (s - Math.sin(2 * Math.PI * s) / (2 * Math.PI));
        up = lift * Math.sin(Math.PI * s);
        curl = leg.curl * Math.sin(Math.PI * s);
      }
      const footWorld = quatMul(rotX(curl), leg.base);
      const target: V3 = [
        leg.restAnkle[0],
        up - lowestSole(leg.sole, footWorld),
        leg.restAnkle[2] + dz,
      ];

      // Two-bone IK from the posed hip (or shoulder) to the ankle target.
      const hip = body.position[leg.u]!;
      const parentRotation = body.rotation[skeleton.parent[leg.u]!] ?? QUAT_IDENTITY;
      const toTarget = sub(target, hip);
      const reach = leg.upper + leg.lower;
      const span = Math.min(
        Math.max(length(toTarget), Math.abs(leg.upper - leg.lower) + 1e-6 * reach),
        reach * (1 - 1e-6),
      );
      const along = normalize(toTarget);
      const kneeWant = rotate(parentRotation, leg.bend.knee);
      let knee = normalize(sub(kneeWant, scale(along, dot(kneeWant, along))));
      if (length(knee) < 1e-9) knee = normalize(cross(along, [1, 0, 0]));
      const a = (leg.upper * leg.upper - leg.lower * leg.lower + span * span) / (2 * span);
      const h = Math.sqrt(Math.max(leg.upper * leg.upper - a * a, 0));
      const kneePos = add(hip, add(scale(along, a), scale(knee, h)));
      const anklePos = add(hip, scale(along, span));
      const normal = normalize(cross(knee, along));
      const P = skeleton.rest;
      const upperWorld = frameRotation(
        normalize(sub(P[leg.l]!, P[leg.u]!)),
        leg.bend.normal,
        normalize(sub(kneePos, hip)),
        normal,
      );
      const lowerWorld = frameRotation(
        normalize(sub(P[leg.a]!, P[leg.l]!)),
        leg.bend.normal,
        normalize(sub(anklePos, kneePos)),
        normal,
      );
      local[leg.u] = quatMul(quatConj(parentRotation), upperWorld);
      local[leg.l] = quatMul(quatConj(upperWorld), lowerWorld);
      local[leg.a] = quatMul(quatConj(lowerWorld), footWorld);
    });

    const previous = rotations.at(-1);
    rotations.push(local.map((q, j) => sameHemisphere(previous?.[j], q)));
    rootTranslation.push(add(skeleton.rest[root]!, offset));
  }
  // The last key is the first pose (phase 1 = phase 0); keep its sign so the loop closes exactly.
  rotations[frames] = rotations[0]!.map((q) => [...q] as Quat);

  return {
    family,
    durationS,
    loop: gait.loop ?? true,
    speedMps: speed,
    times,
    rotations,
    rootTranslation,
    touchdown,
    dutyFactor: duty,
  };
}

function lowestSole(sole: V3[], footWorld: Quat): number {
  let lowest = Infinity;
  for (const o of sole) lowest = Math.min(lowest, rotate(footWorld, o)[1]);
  return lowest;
}

/** How far a leg may straighten at the ends of its stance, as a fraction of its length. */
const MAX_EXTENSION = 0.97;

interface LegGeometry {
  foot: { pair: "fore" | "hind" };
  u: number;
  upper: number;
  lower: number;
  base: Quat;
  sole: V3[];
  restAnkle: V3;
}

/**
 * The root's height offset and extra pitch for the walk: each leg pair's upper joints stand as high
 * as the legs reach at the ends of the stance with the foot planted (flat, when plantigrade), then
 * the hips and shoulders are set to the profile's hip-to-shoulder ratio without overreaching either
 * pair, and the root is raised and pitched until the body meets those heights.
 */
function stance(
  skeleton: Skeleton,
  legs: LegGeometry[],
  sweep: number,
  hipHeightRatio: number,
  bodyPose: (sway: number, pitchExtra: number) => Quat[],
): { rootY: number; pitchExtra: number } {
  const P = skeleton.rest;
  const standing = (pair: "fore" | "hind") => {
    const heights = legs
      .filter((leg) => leg.foot.pair === pair)
      .map((leg) => {
        const ankleY = -lowestSole(leg.sole, leg.base);
        const dx = P[leg.u]![0] - leg.restAnkle[0];
        const dz = Math.abs(P[leg.u]![2] - leg.restAnkle[2]) + sweep / 2;
        const span = MAX_EXTENSION * (leg.upper + leg.lower);
        return ankleY + Math.sqrt(Math.max(span * span - dx * dx - dz * dz, 0));
      });
    // The shortest leg of the pair sets its height, so every foot of the pair can reach the ground.
    return heights.length ? Math.min(...heights) : undefined;
  };
  const upperOf = (pair: "fore" | "hind") =>
    legs.filter((l) => l.foot.pair === pair).map((l) => l.u);
  const hindStand = standing("hind");
  const foreStand = standing("fore");
  const hind = upperOf("hind");
  const fore = upperOf("fore");
  const mean = (fk: Fk, joints: number[], c: number) =>
    joints.reduce((s, j) => s + fk.position[j]![c]!, 0) / joints.length;

  let rootY = 0;
  let pitchExtra = 0;
  if (hindStand === undefined || foreStand === undefined) {
    // One pair of legs (or none): lower or raise the root until that pair stands.
    const stand = hindStand ?? foreStand;
    const pair = hindStand !== undefined ? hind : fore;
    if (stand === undefined || pair.length === 0) return { rootY, pitchExtra };
    for (let i = 0; i < 20; i++) {
      rootY += stand - mean(forwardKinematics(skeleton, bodyPose(0, 0), [0, rootY, 0]), pair, 1);
    }
    return { rootY, pitchExtra };
  }
  const hindTarget = Math.min(hindStand, foreStand * hipHeightRatio);
  const foreTarget = hindTarget / hipHeightRatio;
  for (let i = 0; i < 40; i++) {
    const fk = forwardKinematics(skeleton, bodyPose(0, pitchExtra), [0, rootY, 0]);
    const eh = hindTarget - mean(fk, hind, 1);
    const ef = foreTarget - mean(fk, fore, 1);
    const run = mean(fk, fore, 2) - mean(fk, hind, 2);
    rootY += eh;
    // A positive pitch about +x lowers the front.
    if (Math.abs(run) > 1e-9) pitchExtra -= Math.atan((ef - eh) / run);
    if (Math.abs(eh) + Math.abs(ef) < 1e-7 * skeleton.bodyLength) break;
  }
  return { rootY, pitchExtra };
}
