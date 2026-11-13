/**
 * Generated motions besides locomotion (assetforge#135): a looping idle or a one-shot gesture or
 * interaction, from the key poses a target declares. The body, back, head and tail follow the eased
 * keys; each leg is solved by the gait's inverse kinematics, so a planted foot stays where it stands
 * while the body moves. A one-shot starts on its idle's first pose and blends back to it.
 * Deterministic: no randomness and no provider call.
 */
import type { BakedMesh, Skeleton, SkinWeights } from "./fit.ts";
import {
  FRAMES_PER_SECOND,
  MAX_EXTENSION,
  forwardKinematics,
  legGeometry,
  lowestSole,
  plantLegs,
} from "./gait.ts";
import type { ContactSpan, FootTarget, GeneratedClip, Leg } from "./gait.ts";
import {
  QUAT_IDENTITY,
  add,
  quatAxisAngle,
  quatMul,
  rad,
  rotX,
  rotY,
  sameHemisphere,
} from "./math.ts";
import type { Quat, V3 } from "./math.ts";
import type { MotionPose, MotionProfile } from "./template.ts";

const MIN_FRAMES = 24;
/** A foot lifted less than this (in body lengths) is planted. */
const PLANTED_BODY_LENGTHS = 1e-9;

const rotZ = (radians: number) => quatAxisAngle([0, 0, 1], radians);

/** A pose as named numbers, so two poses blend field by field; an absent field is 0. */
type Flat = Map<string, number>;

function flatten(pose: MotionPose): Flat {
  const out: Flat = new Map();
  for (const [key, value] of Object.entries(pose)) {
    if (typeof value === "number") out.set(key, value);
    else if (key === "body") {
      for (const [k, v] of Object.entries(value as object)) out.set(`body.${k}`, v as number);
    } else if (key === "joints" || key === "feet") {
      for (const [name, fields] of Object.entries(value as Record<string, object>)) {
        for (const [k, v] of Object.entries(fields)) out.set(`${key}.${name}.${k}`, v as number);
      }
    }
  }
  return out;
}

function blend(a: Flat, b: Flat, w: number): Flat {
  const out: Flat = new Map();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key) ?? 0;
    out.set(key, x + ((b.get(key) ?? 0) - x) * w);
  }
  return out;
}

/** The motion's keys on its clip's timeline, in seconds, and the clip's length. Exported for tests. */
export function timeline(
  motion: MotionProfile,
  idle: MotionPose,
): { keys: Array<{ t: number; pose: Flat }>; durationS: number } {
  if (motion.loop) {
    const keys = motion.keys.map((k) => ({ t: k.at * motion.durationS, pose: flatten(k.pose) }));
    // A loop wraps from its last key back to its first.
    keys.push({ t: motion.durationS, pose: keys[0]!.pose });
    return { keys, durationS: motion.durationS };
  }
  const entry = motion.entryS ?? 0;
  const exit = motion.exitS ?? 0;
  const keys = motion.keys.map((k) => ({
    t: entry + k.at * motion.durationS,
    pose: flatten(k.pose),
  }));
  const durationS = entry + motion.durationS + exit;
  if (entry > 0) keys.unshift({ t: 0, pose: flatten(idle) });
  // The last key holds to the end of `durationS`; only then does the exit blend back to the idle.
  const last = keys.at(-1)!;
  if (last.t < entry + motion.durationS)
    keys.push({ t: entry + motion.durationS, pose: last.pose });
  if (exit > 0) keys.push({ t: durationS, pose: flatten(idle) });
  return { keys, durationS };
}

/** The pose at a time: eased (cosine) between the keys around it, held before the first and after the last. */
function poseAt(keys: Array<{ t: number; pose: Flat }>, t: number): Flat {
  if (t <= keys[0]!.t) return keys[0]!.pose;
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t <= b.t) {
      const w = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return blend(a.pose, b.pose, (1 - Math.cos(Math.PI * w)) / 2);
    }
  }
  return keys.at(-1)!.pose;
}

function byRole(skeleton: Skeleton, role: string): number[] {
  return skeleton.template.joints.flatMap((j, i) => (j.role === role ? [i] : []));
}

/**
 * The neutral stance's root height: the fitted rest pose, lowered only as far as every leg needs
 * to reach the ground with its foot flat, never raised.
 */
function neutralRootY(skeleton: Skeleton, legs: Leg[]): number {
  const P = skeleton.rest;
  let rootY = 0;
  for (const leg of legs) {
    const ankleY = -lowestSole(leg.sole, leg.base);
    const dx = P[leg.u]![0] - leg.restAnkle[0];
    const dz = P[leg.u]![2] - leg.restAnkle[2];
    const span = MAX_EXTENSION * (leg.upper + leg.lower);
    const reach = ankleY + Math.sqrt(Math.max(span * span - dx * dx - dz * dz, 0));
    rootY = Math.min(rootY, reach - P[leg.u]![1]);
  }
  return rootY;
}

interface Solved {
  rotations: Quat[];
  rootTranslation: V3;
  planted: boolean[];
}

/** The spans of a clip each foot is down, from its planted flag on each of `frames` frames. */
function contactSpans(planted: boolean[][], frames: number, loop: boolean): ContactSpan[][] {
  const feet = planted[0]?.length ?? 0;
  return Array.from({ length: feet }, (_, f) => {
    const runs: Array<[number, number]> = [];
    for (let k = 0; k < frames; k++) {
      if (!planted[k]![f]) continue;
      const last = runs.at(-1);
      if (last && last[1] === k) last[1] = k + 1;
      else runs.push([k, k + 1]);
    }
    if (runs.length === 1 && runs[0]![0] === 0 && runs[0]![1] === frames) {
      return [{ start: 0, length: 1 }];
    }
    // A loop's run that ends on the last frame goes on into its run from the first.
    if (loop && runs.length > 1 && runs[0]![0] === 0 && runs.at(-1)![1] === frames) {
      const first = runs.shift()!;
      runs.at(-1)![1] = frames + first[1];
    }
    return runs.map(([a, b]) => ({ start: a / frames, length: (b - a) / frames }));
  });
}

/**
 * Generates one motion. `motions` are all the target's motions, so a one-shot finds its idle.
 * `soleVertices` are each foot's sole vertices, so a foot is planted by its sole, not its joint.
 */
export function generateMotion(
  family: string,
  motion: MotionProfile,
  motions: Record<string, MotionProfile>,
  skeleton: Skeleton,
  mesh: BakedMesh,
  soleVertices: number[][],
  skin?: SkinWeights,
): GeneratedClip {
  const L = skeleton.bodyLength;
  const legs = legGeometry(skeleton, mesh, soleVertices);
  const root = skeleton.parent.indexOf(-1);
  const spine = byRole(skeleton, "spine");
  const head = [...byRole(skeleton, "neck"), ...byRole(skeleton, "head")];
  const tail = byRole(skeleton, "tail");
  const index = new Map(skeleton.names.map((name, j) => [name, j]));
  const rootY = neutralRootY(skeleton, legs);

  const solve = (pose: Flat): Solved => {
    const n = (key: string) => pose.get(key) ?? 0;
    const local: Quat[] = skeleton.names.map(() => QUAT_IDENTITY);
    // As in the gait, the root tilts against the back's arch, so the arch hunches the back
    // without dipping the shoulders, and the tail's pitch is measured from level.
    const rootPitch = rad(n("body.pitchDeg") - n("backArchDeg") / 2);
    local[root] = quatMul(
      rotY(rad(n("body.yawDeg"))),
      quatMul(rotX(rootPitch), rotZ(rad(n("body.rollDeg")))),
    );
    for (const j of spine) local[j] = rotX(rad(n("backArchDeg") / spine.length));
    for (const j of head) {
      local[j] = quatMul(
        rotY(rad(n("headYawDeg") / head.length)),
        rotX(rad(n("headPitchDeg") / head.length)),
      );
    }
    tail.forEach((j, i) => {
      local[j] = quatMul(
        rotY(rad(n("tailYawDeg") / tail.length)),
        rotX(rad(n("tailPitchDeg") / tail.length) - (i === 0 ? rootPitch : 0)),
      );
    });
    for (const [name, j] of index) {
      const x = pose.get(`joints.${name}.x`);
      const y = pose.get(`joints.${name}.y`);
      const z = pose.get(`joints.${name}.z`);
      if (x === undefined && y === undefined && z === undefined) continue;
      // X-Y-Z Euler angles, R = Rx · Ry · Rz, after the roles' rotation.
      const extra = quatMul(rotX(rad(x ?? 0)), quatMul(rotY(rad(y ?? 0)), rotZ(rad(z ?? 0))));
      local[j] = quatMul(local[j]!, extra);
    }
    const offset: V3 = [
      n("body.sideBodyLengths") * L,
      rootY + n("body.raiseBodyLengths") * L,
      n("body.forwardBodyLengths") * L,
    ];
    const body = forwardKinematics(skeleton, local, offset);
    const targets: FootTarget[] = legs.map((leg) => {
      const at = (k: string) => n(`feet.${leg.foot.name}.${k}`);
      const lift = at("liftBodyLengths");
      const footWorld = quatMul(rotX(rad(at("curlDeg"))), leg.base);
      const up = lift * L;
      return {
        footWorld,
        target: [
          leg.restAnkle[0] + at("sideBodyLengths") * L,
          up - lowestSole(leg.sole, footWorld),
          leg.restAnkle[2] + at("forwardBodyLengths") * L,
        ],
        up,
        stance: lift <= PLANTED_BODY_LENGTHS,
      };
    });
    plantLegs(skeleton, mesh, legs, targets, soleVertices, local, offset, body, skin);
    return {
      rotations: local,
      rootTranslation: add(skeleton.rest[root]!, offset),
      planted: targets.map((t) => t.stance),
    };
  };

  const idlePose: MotionPose =
    (motion.idle !== undefined ? motions[motion.idle]?.keys[0]?.pose : undefined) ?? {};
  const { keys, durationS } = timeline(motion, idlePose);
  const frames = Math.max(MIN_FRAMES, Math.round(durationS * FRAMES_PER_SECOND));
  const times: number[] = [];
  const rotations: Quat[][] = [];
  const rootTranslation: V3[] = [];
  const planted: boolean[][] = [];
  for (let k = 0; k <= frames; k++) {
    const t = (k / frames) * durationS;
    const solved = solve(poseAt(keys, t));
    const previous = rotations.at(-1);
    times.push(t);
    rotations.push(solved.rotations.map((q, j) => sameHemisphere(previous?.[j], q)));
    rootTranslation.push(solved.rootTranslation);
    planted.push(solved.planted);
  }
  if (motion.loop) {
    // The last key is the first pose; keep its sign so the loop closes exactly.
    rotations[frames] = rotations[0]!.map((q) => [...q] as Quat);
    rootTranslation[frames] = [...rootTranslation[0]!];
  }
  const ends = motion.loop ? undefined : solve(flatten(idlePose));

  return {
    family,
    durationS,
    loop: motion.loop,
    speedMps: 0,
    times,
    rotations,
    rootTranslation,
    contacts: contactSpans(planted, frames, motion.loop),
    ...(ends && {
      ends: {
        from: motion.idle ?? "the neutral stance",
        rotations: ends.rotations,
        rootTranslation: ends.rootTranslation,
      },
    }),
  };
}
