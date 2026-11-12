/**
 * The texel map of a character's base-colour texture: for every texel the triangle of the mesh that
 * covers it in UV space, with the surface point, normal and skin joint there.
 */
import { readAccessor } from "../glb.ts";
import type { Glb } from "../glb.ts";
import { posedPrimitives, worldMatrices } from "../scene.ts";
import type { PosedPrimitive } from "../scene.ts";

export interface TexelMap {
  /** Edge in px (square). */
  size: number;
  /** `size*size`, 1 where a triangle of the textured primitives covers the texel. */
  covered: Uint8Array;
  /** `size*size*3` world-space rest-pose surface point. */
  position: Float32Array;
  /** `size*size*3` unit normal (interpolated vertex normals, else the face normal). */
  normal: Float32Array;
  /** `size*size` dominant skin joint (an index into `skin.joints`), -1 when unskinned. */
  joint: Int16Array;
}

export interface TexturedPrimitive extends PosedPrimitive {
  /** Per vertex, the skin joint with the largest weight; absent when the primitive is unskinned. */
  dominantJoint?: Int16Array;
  /** The image index of the material's base-colour texture. */
  image?: number;
}

function imageOf(glb: Glb, material: number | undefined): number | undefined {
  const texture =
    material === undefined
      ? undefined
      : glb.json.materials?.[material]?.pbrMetallicRoughness?.baseColorTexture?.index;
  return texture === undefined ? undefined : glb.json.textures?.[texture]?.source;
}

/**
 * The rest-pose primitives with UVs whose base-colour texture is `image` (all of them when it is
 * undefined), each with its vertices' dominant joint. Order and filtering follow `posedPrimitives`.
 */
export function texturedPrimitives(glb: Glb, image?: number): TexturedPrimitive[] {
  const posed = posedPrimitives(glb);
  const joints: Array<Int16Array | undefined> = [];
  const { json } = glb;
  for (const nodeIndex of worldMatrices(json).keys()) {
    const node = json.nodes?.[nodeIndex];
    if (node?.mesh === undefined) continue;
    const mesh = json.meshes?.[node.mesh];
    if (!mesh) continue;
    const skinned = node.skin !== undefined && json.skins?.[node.skin] !== undefined;
    for (const primitive of mesh.primitives) {
      const mode = primitive.mode ?? 4;
      if (![4, 5, 6].includes(mode) || primitive.attributes["POSITION"] === undefined) continue;
      const jointAttr = primitive.attributes["JOINTS_0"];
      if (!skinned || jointAttr === undefined) {
        joints.push(undefined);
        continue;
      }
      const ids = readAccessor(glb, jointAttr);
      const weightAttr = primitive.attributes["WEIGHTS_0"];
      const weights = weightAttr === undefined ? undefined : readAccessor(glb, weightAttr);
      const count = ids.length / 4;
      const dominant = new Int16Array(count);
      for (let v = 0; v < count; v++) {
        let best = 0;
        for (let k = 1; k < 4; k++) {
          if ((weights?.[v * 4 + k] ?? 0) > (weights?.[v * 4 + best] ?? 0)) best = k;
        }
        dominant[v] = ids[v * 4 + best]!;
      }
      joints.push(dominant);
    }
  }
  const out: TexturedPrimitive[] = [];
  posed.forEach((prim, i) => {
    if (!prim.uvs) return;
    const own = imageOf(glb, prim.material);
    if (image !== undefined && own !== image) return;
    const dominant = joints[i];
    out.push({
      ...prim,
      ...(dominant && { dominantJoint: dominant }),
      ...(own !== undefined && { image: own }),
    });
  });
  return out;
}

/**
 * Rasterises in UV space every triangle of the primitives whose material's baseColorTexture uses
 * image `image` (all primitives with TEXCOORD_0 when `image` is undefined). Texel (u, v) is pixel
 * (u*size, v*size), v not flipped. A texel whose centre lies within half a texel of a triangle is
 * covered, so islands have no cracks; a texel inside a triangle is never taken by a near miss.
 */
export function bakeTexels(glb: Glb, sizePx: number, image?: number): TexelMap {
  const size = sizePx;
  const covered = new Uint8Array(size * size);
  const exact = new Uint8Array(size * size);
  const position = new Float32Array(size * size * 3);
  const normal = new Float32Array(size * size * 3);
  const joint = new Int16Array(size * size).fill(-1);

  for (const prim of texturedPrimitives(glb, image)) {
    const { positions, normals, uvs, indices, dominantJoint } = prim;
    if (!uvs) continue;
    const count = positions.length / 3;
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = indices[t]!;
      const b = indices[t + 1]!;
      const c = indices[t + 2]!;
      if (a >= count || b >= count || c >= count) continue;
      const ax = uvs[a * 2]! * size;
      const ay = uvs[a * 2 + 1]! * size;
      const bx = uvs[b * 2]! * size;
      const by = uvs[b * 2 + 1]! * size;
      const cx = uvs[c * 2]! * size;
      const cy = uvs[c * 2 + 1]! * size;
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(area) < 1e-12) continue;
      const inv = 1 / area;
      // Barycentric weight w_i is the distance to the opposite edge over that edge's height.
      const lenA = Math.hypot(cx - bx, cy - by) / Math.abs(area);
      const lenB = Math.hypot(ax - cx, ay - cy) / Math.abs(area);
      const lenC = Math.hypot(bx - ax, by - ay) / Math.abs(area);
      const slackA = -0.5 * lenA;
      const slackB = -0.5 * lenB;
      const slackC = -0.5 * lenC;
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5));
      const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx) + 0.5));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5));
      const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy) + 0.5));

      const p = positions;
      let fx = 0;
      let fy = 0;
      let fz = 0;
      if (!normals) {
        const e1x = p[b * 3]! - p[a * 3]!;
        const e1y = p[b * 3 + 1]! - p[a * 3 + 1]!;
        const e1z = p[b * 3 + 2]! - p[a * 3 + 2]!;
        const e2x = p[c * 3]! - p[a * 3]!;
        const e2y = p[c * 3 + 1]! - p[a * 3 + 1]!;
        const e2z = p[c * 3 + 2]! - p[a * 3 + 2]!;
        fx = e1y * e2z - e1z * e2y;
        fy = e1z * e2x - e1x * e2z;
        fz = e1x * e2y - e1y * e2x;
        const l = Math.hypot(fx, fy, fz) || 1;
        fx /= l;
        fy /= l;
        fz /= l;
      }

      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          let w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) * inv;
          let w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) * inv;
          let w2 = 1 - w0 - w1;
          if (w0 < slackA || w1 < slackB || w2 < slackC) continue;
          const inside = w0 >= 0 && w1 >= 0 && w2 >= 0;
          const at = y * size + x;
          if (covered[at] && (exact[at] || !inside)) continue;
          if (!inside) {
            w0 = Math.max(0, w0);
            w1 = Math.max(0, w1);
            w2 = Math.max(0, w2);
            const s = w0 + w1 + w2 || 1;
            w0 /= s;
            w1 /= s;
            w2 /= s;
          }
          covered[at] = 1;
          exact[at] = inside ? 1 : 0;
          for (let k = 0; k < 3; k++) {
            position[at * 3 + k] = w0 * p[a * 3 + k]! + w1 * p[b * 3 + k]! + w2 * p[c * 3 + k]!;
          }
          if (normals) {
            const nx = w0 * normals[a * 3]! + w1 * normals[b * 3]! + w2 * normals[c * 3]!;
            const ny =
              w0 * normals[a * 3 + 1]! + w1 * normals[b * 3 + 1]! + w2 * normals[c * 3 + 1]!;
            const nz =
              w0 * normals[a * 3 + 2]! + w1 * normals[b * 3 + 2]! + w2 * normals[c * 3 + 2]!;
            const l = Math.hypot(nx, ny, nz);
            if (l > 1e-9) {
              normal[at * 3] = nx / l;
              normal[at * 3 + 1] = ny / l;
              normal[at * 3 + 2] = nz / l;
            } else {
              normal[at * 3 + 1] = 1;
            }
          } else {
            normal[at * 3] = fx;
            normal[at * 3 + 1] = fy;
            normal[at * 3 + 2] = fz;
          }
          if (dominantJoint) {
            const nearest = w0 >= w1 && w0 >= w2 ? a : w1 >= w2 ? b : c;
            joint[at] = dominantJoint[nearest]!;
          } else {
            joint[at] = -1;
          }
        }
      }
    }
  }
  return { size, covered, position, normal, joint };
}
