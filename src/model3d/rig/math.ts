/** Vector and quaternion helpers for the shared rig (quaternions are [x, y, z, w], as glTF). */
export type V3 = [number, number, number];
export type Quat = [number, number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: V3): V3 => {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const deg = (r: number) => (r * 180) / Math.PI;
export const rad = (d: number) => (d * Math.PI) / 180;

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export const quatConj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

export function quatAxisAngle(axis: V3, radians: number): Quat {
  const n = normalize(axis);
  const s = Math.sin(radians / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(radians / 2)];
}

export const rotX = (radians: number) => quatAxisAngle([1, 0, 0], radians);
export const rotY = (radians: number) => quatAxisAngle([0, 1, 0], radians);

export function rotate(q: Quat, v: V3): V3 {
  const u: V3 = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
}

/** The quaternion of a rotation matrix given as rows. */
export function quatFromRows(m: [V3, V3, V3]): Quat {
  const [[m00, m01, m02], [m10, m11, m12], [m20, m21, m22]] = m;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const l = Math.hypot(...q) || 1;
  return q.map((v) => v / l) as Quat;
}

/** The rotation taking the orthonormal pair (a, n) onto (a2, n2). */
export function frameRotation(a: V3, n: V3, a2: V3, n2: V3): Quat {
  const b = cross(a, n);
  const b2 = cross(a2, n2);
  // R = B2 · Bᵀ, with the basis vectors as columns.
  const row = (r: number): V3 => [
    a2[r]! * a[0] + n2[r]! * n[0] + b2[r]! * b[0],
    a2[r]! * a[1] + n2[r]! * n[1] + b2[r]! * b[1],
    a2[r]! * a[2] + n2[r]! * n[2] + b2[r]! * b[2],
  ];
  return quatFromRows([row(0), row(1), row(2)]);
}

/** X-Y-Z Euler angles in degrees of a rotation (R = Rx · Ry · Rz). */
export function eulerXyzDeg(q: Quat): V3 {
  const [x, y, z, w] = q;
  const r00 = 1 - 2 * (y * y + z * z);
  const r01 = 2 * (x * y - z * w);
  const r02 = 2 * (x * z + y * w);
  const r12 = 2 * (y * z - x * w);
  const r22 = 1 - 2 * (x * x + y * y);
  const sy = Math.max(-1, Math.min(1, r02));
  return [deg(Math.atan2(-r12, r22)), deg(Math.asin(sy)), deg(Math.atan2(-r01, r00))];
}

/** Keeps successive quaternions in one hemisphere, so linear keys interpolate the short way. */
export function sameHemisphere(previous: Quat | undefined, q: Quat): Quat {
  if (!previous) return q;
  const d = previous[0] * q[0] + previous[1] * q[1] + previous[2] * q[2] + previous[3] * q[3];
  return d < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}
