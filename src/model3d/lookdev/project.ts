/**
 * Back-projection of restyled turntable views onto a character's UV texels, filling what no view
 * saw from the source texture, dilating islands, and checking seams.
 */
import { createRaster } from "../../image/raster.ts";
import type { Raster } from "../../image/raster.ts";
import type { Glb } from "../glb.ts";
import type { ViewCamera } from "../render.ts";
import { posedPrimitives } from "../scene.ts";
import { texturedPrimitives } from "./texels.ts";
import type { TexelMap } from "./texels.ts";

export interface ProjectedView {
  camera: ViewCamera;
  /** Same size as `camera.sizePx`. */
  image: Raster;
  /**
   * Pixels the image left as background (1), per pixel; never projected, so a restyle whose figure
   * is thinner than the model's (a leg drawn narrower) cannot paint background onto the texels.
   */
  background?: Uint8Array;
}

export interface Projection {
  /** Texel-size RGBA; only texels with weight > 0 hold a projected colour. */
  color: Raster;
  /** Per texel, the summed view weights; 0 = unseen. */
  weight: Float32Array;
  /** The share of covered texels with weight > 0. */
  coverage: number;
}

const FACING_POWER = 4;
/**
 * Where the views agree on a texel (the weighted spread of their colours under AGREE_SPREAD,
 * 0..255, smoothed over BLEND_RADIUS of the texture's edge), the colour is their facing^4 mean.
 * Where they disagree (over DISAGREE_SPREAD), the facing power rises smoothly to DISAGREE_POWER,
 * so the view that sees the texel most squarely takes it over: a marking two views paint in
 * slightly different places stays crisp in each instead of averaging to grey (assetforge#122).
 */
const AGREE_SPREAD = 12;
const DISAGREE_SPREAD = 36;
const BLEND_RADIUS = 0.008;
const DISAGREE_POWER = 48;
const MIN_FACING = 0.15;

/** The depth of the nearest surface per pixel for a camera (Infinity where empty); as `renderView`. */
export function depthMap(glb: Glb, camera: ViewCamera): Float32Array {
  const size = camera.sizePx;
  const { eye, forward, right, up, focal, near } = camera;
  const buffer = new Float64Array(size * size).fill(Infinity);
  for (const prim of posedPrimitives(glb)) {
    const count = prim.positions.length / 3;
    const sx = new Float64Array(count);
    const sy = new Float64Array(count);
    const sz = new Float64Array(count);
    for (let v = 0; v < count; v++) {
      const dx = prim.positions[v * 3]! - eye[0];
      const dy = prim.positions[v * 3 + 1]! - eye[1];
      const dz = prim.positions[v * 3 + 2]! - eye[2];
      const z = dx * forward[0] + dy * forward[1] + dz * forward[2];
      sz[v] = z;
      sx[v] = size / 2 + (focal * (dx * right[0] + dy * right[1] + dz * right[2])) / z;
      sy[v] = size / 2 - (focal * (dx * up[0] + dy * up[1] + dz * up[2])) / z;
    }
    for (let t = 0; t + 2 < prim.indices.length; t += 3) {
      const i0 = prim.indices[t]!;
      const i1 = prim.indices[t + 1]!;
      const i2 = prim.indices[t + 2]!;
      if (i0 >= count || i1 >= count || i2 >= count) continue;
      const z0 = sz[i0]!;
      const z1 = sz[i1]!;
      const z2 = sz[i2]!;
      if (z0 < near || z1 < near || z2 < near) continue;
      const x0 = sx[i0]!;
      const y0 = sy[i0]!;
      const x1 = sx[i1]!;
      const y1 = sy[i1]!;
      const x2 = sx[i2]!;
      const y2 = sy[i2]!;
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (area === 0) continue;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2)));
      const iz0 = 1 / z0;
      const iz1 = 1 / z1;
      const iz2 = 1 / z2;
      const invArea = 1 / area;
      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * invArea;
          const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * invArea;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const depth = 1 / (w0 * iz0 + w1 * iz1 + w2 * iz2);
          const at = y * size + x;
          if (depth < buffer[at]!) buffer[at] = depth;
        }
      }
    }
  }
  return Float32Array.from(buffer);
}

/** Pixels whose neighbourhood is background or a depth cliff; their colour mixes surfaces. */
function silhouetteMask(depth: Float32Array, size: number): Uint8Array {
  const edge = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = y * size + x;
      const d = depth[at]!;
      if (d === Infinity) {
        edge[at] = 1;
        continue;
      }
      const limit = d * 0.03;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
        const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) {
          edge[at] = 1;
          break;
        }
        const n = depth[ny * size + nx]!;
        if (n === Infinity || Math.abs(n - d) > limit) {
          edge[at] = 1;
          break;
        }
      }
    }
  }
  return edge;
}

/**
 * Back-projects each view onto the texels. A texel takes a view's pixel only where it is visible
 * (its depth within a tolerance of the depth map), faces the camera and is away from silhouettes;
 * its weight is max(0, n·toCamera)^4 so square-on views dominate, and the colour is the weighted
 * average over views, sharpened toward the most square-on view where the views disagree. `depths[i]` is `depthMap` of `views[i].camera`.
 */
export function projectViews(
  glb: Glb,
  texels: TexelMap,
  views: ProjectedView[],
  depths: Float32Array[],
): Projection {
  void glb;
  const { size, covered, position, normal } = texels;
  const total = size * size;
  const sum = new Float32Array(total * 3);
  const sumSq = new Float32Array(total);
  const weight = new Float32Array(total);
  const squarest = new Float32Array(total);

  let minP = [Infinity, Infinity, Infinity];
  let maxP = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < total; i++) {
    if (!covered[i]) continue;
    for (let k = 0; k < 3; k++) {
      const v = position[i * 3 + k]!;
      if (v < minP[k]!) minP[k] = v;
      if (v > maxP[k]!) maxP[k] = v;
    }
  }
  if (!Number.isFinite(minP[0])) {
    minP = [0, 0, 0];
    maxP = [0, 0, 0];
  }
  const diagonal = Math.hypot(maxP[0]! - minP[0]!, maxP[1]! - minP[1]!, maxP[2]! - minP[2]!);

  /** Calls `visit` for each texel each view sees, with the view's pixel and facing. */
  const eachSeen = (visit: (i: number, image: Raster, pixel: number, facing: number) => void) =>
    views.forEach((view, v) => {
      const depth = depths[v];
      if (!depth) return;
      const { camera, image } = view;
      const px = camera.sizePx;
      const edge = silhouetteMask(depth, px);
      const { background } = view;
      const { eye } = camera;
      for (let i = 0; i < total; i++) {
        if (!covered[i]) continue;
        const x = position[i * 3]!;
        const y = position[i * 3 + 1]!;
        const z = position[i * 3 + 2]!;
        const tx = eye[0] - x;
        const ty = eye[1] - y;
        const tz = eye[2] - z;
        const distance = Math.hypot(tx, ty, tz) || 1;
        const facing =
          (normal[i * 3]! * tx + normal[i * 3 + 1]! * ty + normal[i * 3 + 2]! * tz) / distance;
        if (facing < MIN_FACING) continue;
        const [sx, sy, d] = camera.project(x, y, z);
        const ix = Math.floor(sx);
        const iy = Math.floor(sy);
        if (!(d > 0) || ix < 0 || iy < 0 || ix >= px || iy >= px) continue;
        const pixel = iy * px + ix;
        if (edge[pixel] || background?.[pixel]) continue;
        const tolerance = 0.005 * distance + 0.003 * diagonal + (1.5 * d) / camera.focal / facing;
        if (Math.abs(depth[pixel]! - d) > tolerance) continue;
        visit(i, image, pixel, facing);
      }
    });

  // Pass 1: how much the views disagree on each texel (the weighted spread of their colours).
  eachSeen((i, image, pixel, facing) => {
    const w = facing ** FACING_POWER;
    const r = image.data[pixel * 4]!;
    const g = image.data[pixel * 4 + 1]!;
    const b = image.data[pixel * 4 + 2]!;
    sum[i * 3]! += r * w;
    sum[i * 3 + 1]! += g * w;
    sum[i * 3 + 2]! += b * w;
    sumSq[i]! += (r * r + g * g + b * b) * w;
    weight[i]! += w;
    if (facing > squarest[i]!) squarest[i] = facing;
  });
  const spread = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const w = weight[i]!;
    if (!covered[i] || w <= 0) continue;
    const m0 = sum[i * 3]! / w;
    const m1 = sum[i * 3 + 1]! / w;
    const m2 = sum[i * 3 + 2]! / w;
    spread[i] = Math.sqrt(Math.max(0, sumSq[i]! / w - m0 * m0 - m1 * m1 - m2 * m2));
  }
  const radius = Math.max(1, Math.round(size * BLEND_RADIUS));
  const smooth = boxBlurSeen(spread, weight, covered, size, radius);
  const power = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const t = smoothstep(AGREE_SPREAD, DISAGREE_SPREAD, smooth[i]!);
    power[i] = FACING_POWER + (DISAGREE_POWER - FACING_POWER) * t;
  }

  // Pass 2: the colour, with the facing sharpened where the views disagree.
  sum.fill(0);
  const sharpWeight = new Float32Array(total);
  eachSeen((i, image, pixel, facing) => {
    // Relative to the squarest view's facing, so a high power cannot underflow to no weight.
    const w = (facing / squarest[i]!) ** power[i]!;
    sum[i * 3]! += image.data[pixel * 4]! * w;
    sum[i * 3 + 1]! += image.data[pixel * 4 + 1]! * w;
    sum[i * 3 + 2]! += image.data[pixel * 4 + 2]! * w;
    sharpWeight[i]! += w;
  });

  const color = createRaster(size, size);
  let seen = 0;
  let count = 0;
  for (let i = 0; i < total; i++) {
    if (!covered[i]) continue;
    count++;
    const w = sharpWeight[i]!;
    if (weight[i]! <= 0 || w <= 0) continue;
    seen++;
    color.data[i * 4] = Math.round(sum[i * 3]! / w);
    color.data[i * 4 + 1] = Math.round(sum[i * 3 + 1]! / w);
    color.data[i * 4 + 2] = Math.round(sum[i * 3 + 2]! / w);
    color.data[i * 4 + 3] = 255;
  }
  return { color, weight, coverage: count === 0 ? 0 : seen / count };
}

/** A separable box blur of `values` over seen, covered texels only (the mean of those in reach). */
function boxBlurSeen(
  values: Float32Array,
  weight: Float32Array,
  covered: Uint8Array,
  size: number,
  radius: number,
): Float32Array {
  const ok = (i: number) => covered[i]! > 0 && weight[i]! > 0;
  const pass = (src: Float32Array, cnt: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(src.length);
    const outCnt = new Float32Array(src.length);
    for (let line = 0; line < size; line++) {
      let acc = 0;
      let n = 0;
      const at = (k: number) => (horizontal ? line * size + k : k * size + line);
      for (let k = 0; k < Math.min(radius, size); k++) {
        acc += src[at(k)]!;
        n += cnt[at(k)]!;
      }
      for (let k = 0; k < size; k++) {
        const add = k + radius;
        if (add < size) {
          acc += src[at(add)]!;
          n += cnt[at(add)]!;
        }
        const drop = k - radius - 1;
        if (drop >= 0) {
          acc -= src[at(drop)]!;
          n -= cnt[at(drop)]!;
        }
        out[at(k)] = acc;
        outCnt[at(k)] = n;
      }
    }
    return [out, outCnt] as const;
  };
  const v0 = new Float32Array(values.length);
  const c0 = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (!ok(i)) continue;
    v0[i] = values[i]!;
    c0[i] = 1;
  }
  const [v1, c1] = pass(v0, c0, true);
  const [v2, c2] = pass(v1, c1, false);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = c2[i]! > 0 ? v2[i]! / c2[i]! : 0;
  return out;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Bilinear sample with wrap, the texture convention of the renderer. */
function sample(texture: Raster, u: number, v: number, out: number[]): void {
  const { width, height, data } = texture;
  const x = u * width - 0.5;
  const y = v * height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = Math.min(width - 1, Math.max(0, x0));
  const xb = Math.min(width - 1, Math.max(0, x0 + 1));
  const ya = Math.min(height - 1, Math.max(0, y0));
  const yb = Math.min(height - 1, Math.max(0, y0 + 1));
  for (let c = 0; c < 4; c++) {
    const top = data[(ya * width + xa) * 4 + c]! * (1 - fx) + data[(ya * width + xb) * 4 + c]! * fx;
    const bottom =
      data[(yb * width + xa) * 4 + c]! * (1 - fx) + data[(yb * width + xb) * 4 + c]! * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
}

function resized(source: Raster, size: number): Raster {
  if (source.width === size && source.height === size) return source;
  const out = createRaster(size, size);
  const px = [0, 0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      sample(source, (x + 0.5) / size, (y + 0.5) / size, px);
      for (let c = 0; c < 4; c++) out.data[(y * size + x) * 4 + c] = Math.round(px[c]!);
    }
  }
  return out;
}

const SEEN = 0.2;

/**
 * Fills texels with low or no weight from the source texture (resized when sizes differ),
 * colour-matched per channel by mean and standard deviation over the texels both seen and covered,
 * blending smoothly by weight. Returns the full texture; uncovered texels keep the source.
 */
export function fillUnseen(projection: Projection, texels: TexelMap, source: Raster): Raster {
  const { size, covered } = texels;
  const total = size * size;
  const base = resized(source, size);
  const { color, weight } = projection;

  const mean = [0, 0, 0];
  const meanSource = [0, 0, 0];
  const m2 = [0, 0, 0];
  const m2Source = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < total; i++) {
    if (!covered[i] || weight[i]! < SEEN) continue;
    n++;
    for (let c = 0; c < 3; c++) {
      const p = color.data[i * 4 + c]!;
      const s = base.data[i * 4 + c]!;
      mean[c]! += p;
      meanSource[c]! += s;
      m2[c]! += p * p;
      m2Source[c]! += s * s;
    }
  }
  const scale = [1, 1, 1];
  const shift = [0, 0, 0];
  if (n > 0) {
    for (let c = 0; c < 3; c++) {
      const mp = mean[c]! / n;
      const ms = meanSource[c]! / n;
      const sp = Math.sqrt(Math.max(0, m2[c]! / n - mp * mp));
      const ss = Math.sqrt(Math.max(0, m2Source[c]! / n - ms * ms));
      scale[c] = ss > 1e-6 ? Math.min(4, Math.max(0.25, sp / ss)) : 1;
      shift[c] = mp - ms * scale[c]!;
    }
  }

  const matched = new Float32Array(total * 3);
  const alpha = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    if (!covered[i]) continue;
    alpha[i] = smoothstep(0.02, SEEN, weight[i]!);
    for (let c = 0; c < 3; c++) {
      matched[i * 3 + c] = Math.min(
        255,
        Math.max(0, base.data[i * 4 + c]! * scale[c]! + shift[c]!),
      );
    }
  }
  const offset = localResidual(
    texels,
    alpha,
    (i, c) => color.data[i * 4 + c]! - matched[i * 3 + c]!,
  );

  const out = createRaster(size, size);
  out.data.set(base.data);
  for (let i = 0; i < total; i++) {
    if (!covered[i]) continue;
    const a = alpha[i]!;
    for (let c = 0; c < 3; c++) {
      const fill = Math.min(255, Math.max(0, matched[i * 3 + c]! + offset[i * 3 + c]!));
      const projected = color.data[i * 4 + c]!;
      out.data[i * 4 + c] = Math.round(fill + (projected - fill) * a);
    }
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * A voxel grid over the covered surface's bounds: texels splat weighted values into it and gather
 * the local weighted mean back, trilinearly, so a neighbourhood is measured in space and stays
 * continuous across UV seams.
 */
class SurfaceGrid {
  private readonly mass: Float32Array;
  private readonly sum: Float32Array;
  private readonly nx: number;
  private readonly ny: number;
  private readonly texels: TexelMap;
  private readonly bounds: { min: number[]; max: number[] };
  private readonly cell: number;
  private readonly channels: number;
  constructor(
    texels: TexelMap,
    bounds: { min: number[]; max: number[] },
    cell: number,
    channels: number,
  ) {
    this.texels = texels;
    this.bounds = bounds;
    this.cell = cell;
    this.channels = channels;
    const { min, max } = bounds;
    this.nx = Math.max(1, Math.ceil((max[0]! - min[0]!) / cell) + 2);
    this.ny = Math.max(1, Math.ceil((max[1]! - min[1]!) / cell) + 2);
    const nz = Math.max(1, Math.ceil((max[2]! - min[2]!) / cell) + 2);
    this.mass = new Float32Array(this.nx * this.ny * nz);
    this.sum = new Float32Array(this.mass.length * channels);
  }

  private corners(i: number, visit: (at: number, w: number) => void): void {
    const { position } = this.texels;
    const { min } = this.bounds;
    const gx = (position[i * 3]! - min[0]!) / this.cell + 0.5;
    const gy = (position[i * 3 + 1]! - min[1]!) / this.cell + 0.5;
    const gz = (position[i * 3 + 2]! - min[2]!) / this.cell + 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fy = gy - y0;
    const fz = gz - z0;
    for (let dz = 0; dz < 2; dz++) {
      const wz = dz ? fz : 1 - fz;
      for (let dy = 0; dy < 2; dy++) {
        const wy = dy ? fy : 1 - fy;
        for (let dx = 0; dx < 2; dx++) {
          const w = (dx ? fx : 1 - fx) * wy * wz;
          if (w > 0) visit(((z0 + dz) * this.ny + (y0 + dy)) * this.nx + (x0 + dx), w);
        }
      }
    }
  }

  splat(i: number, weight: number, values: ArrayLike<number>): void {
    const k = this.channels;
    this.corners(i, (at, w) => {
      const m = w * weight;
      this.mass[at]! += m;
      for (let c = 0; c < k; c++) this.sum[at * k + c]! += values[c]! * m;
    });
  }

  /** The weighted mean around texel `i` into `out`; returns the mass it rests on. */
  gather(i: number, out: number[]): number {
    const k = this.channels;
    let m = 0;
    out.fill(0);
    this.corners(i, (at, w) => {
      m += this.mass[at]! * w;
      for (let c = 0; c < k; c++) out[c]! += this.sum[at * k + c]! * w;
    });
    if (m > 0) for (let c = 0; c < k; c++) out[c]! /= m;
    return m;
  }

  /** The median mass of the occupied cells: what a cell of surface typically holds. */
  typicalMass(): number {
    const occupied: number[] = [];
    for (const m of this.mass) if (m > 0) occupied.push(m);
    if (occupied.length === 0) return 0;
    occupied.sort((a, b) => a - b);
    return occupied[occupied.length >> 1]!;
  }
}

function coveredBounds(texels: TexelMap): { min: number[]; max: number[]; diagonal: number } {
  const { size, covered, position } = texels;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < size * size; i++) {
    if (!covered[i]) continue;
    for (let k = 0; k < 3; k++) {
      const v = position[i * 3 + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0], diagonal: 0 };
  return {
    min,
    max,
    diagonal: Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!),
  };
}

/** The finest cell of `localResidual`, as a share of the covered surface's bounding diagonal. */
const RESIDUAL_CELL = 0.012;
const RESIDUAL_LEVELS = 6;

/**
 * Per covered texel, the local mean of `residual` (projected minus colour-matched source) over the
 * seen texels around it in 3D, weighted by how well each was seen: finest where enough seen texels
 * are near, falling back smoothly to coarser cells (each level doubles the cell). A texel no view
 * sees squarely then takes the colour its seen neighbours were painted, not the source's own
 * marking there (assetforge#129).
 */
function localResidual(
  texels: TexelMap,
  alpha: Float32Array,
  residual: (i: number, c: number) => number,
): Float32Array {
  const { size, covered } = texels;
  const total = size * size;
  const out = new Float32Array(total * 3);
  const bounds = coveredBounds(texels);
  if (!(bounds.diagonal > 0)) return out;
  const r = [0, 0, 0];
  for (let level = RESIDUAL_LEVELS - 1; level >= 0; level--) {
    const grid = new SurfaceGrid(texels, bounds, bounds.diagonal * RESIDUAL_CELL * 2 ** level, 3);
    for (let i = 0; i < total; i++) {
      if (!covered[i] || alpha[i]! <= 0) continue;
      for (let c = 0; c < 3; c++) r[c] = residual(i, c);
      grid.splat(i, alpha[i]!, r);
    }
    // A local mean stands once it rests on a quarter of what a cell of surface typically holds.
    const enough = 0.25 * grid.typicalMass();
    if (!(enough > 0)) continue;
    for (let i = 0; i < total; i++) {
      if (!covered[i] || alpha[i]! >= 1) continue;
      const m = grid.gather(i, r);
      if (m <= 0) continue;
      const t = Math.min(1, m / enough);
      for (let c = 0; c < 3; c++) out[i * 3 + c]! += (r[c]! - out[i * 3 + c]!) * t;
    }
  }
  return out;
}

/** Pushes covered texels' colours outward into uncovered texels for `px` rings. */
export function dilate(texture: Raster, covered: Uint8Array, px: number): Raster {
  const { width, height } = texture;
  const out: Raster = { width, height, data: Uint8Array.from(texture.data) };
  let filled = Uint8Array.from(covered);
  for (let ring = 0; ring < px; ring++) {
    const next = Uint8Array.from(filled);
    let changed = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = y * width + x;
        if (filled[at]) continue;
        let n = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const o = ny * width + nx;
            if (!filled[o]) continue;
            n++;
            r += out.data[o * 4]!;
            g += out.data[o * 4 + 1]!;
            b += out.data[o * 4 + 2]!;
            a += out.data[o * 4 + 3]!;
          }
        }
        if (n === 0) continue;
        out.data[at * 4] = Math.round(r / n);
        out.data[at * 4 + 1] = Math.round(g / n);
        out.data[at * 4 + 2] = Math.round(b / n);
        out.data[at * 4 + 3] = Math.round(a / n);
        next[at] = 1;
        changed = true;
      }
    }
    filled = next;
    if (!changed) break;
  }
  return out;
}

/**
 * Seam check: for every mesh edge shared by two triangles (vertices welded by position) whose UVs
 * differ, samples the texture along both UV edges. Returns the number of seam edges and the mean
 * and 95th-percentile of the per-edge mean RGB distance (0–255 scale).
 */
export function seamError(
  glb: Glb,
  texture: Raster,
  image?: number,
): { edges: number; mean: number; p95: number } {
  const welded = new Map<string, number>();
  const edges = new Map<string, number[]>();
  const quantum = 1e5;
  const weld = (p: Float64Array, v: number): number => {
    const key = `${Math.round(p[v * 3]! * quantum)},${Math.round(p[v * 3 + 1]! * quantum)},${Math.round(p[v * 3 + 2]! * quantum)}`;
    let id = welded.get(key);
    if (id === undefined) welded.set(key, (id = welded.size));
    return id;
  };
  const same = (a: number, b: number, c: number, d: number) =>
    Math.abs(a - c) < 1e-6 && Math.abs(b - d) < 1e-6;

  const distances: number[] = [];
  const first = [0, 0, 0, 0];
  const second = [0, 0, 0, 0];
  const compare = (u0: number[], u1: number[]) => {
    const length = Math.max(
      Math.hypot((u0[2]! - u0[0]!) * texture.width, (u0[3]! - u0[1]!) * texture.height),
      Math.hypot((u1[2]! - u1[0]!) * texture.width, (u1[3]! - u1[1]!) * texture.height),
    );
    const steps = Math.min(64, Math.max(2, Math.ceil(length)));
    let sum = 0;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      sample(texture, u0[0]! + (u0[2]! - u0[0]!) * t, u0[1]! + (u0[3]! - u0[1]!) * t, first);
      sample(texture, u1[0]! + (u1[2]! - u1[0]!) * t, u1[1]! + (u1[3]! - u1[1]!) * t, second);
      sum += Math.hypot(first[0]! - second[0]!, first[1]! - second[1]!, first[2]! - second[2]!);
    }
    distances.push(sum / (steps + 1));
  };

  for (const prim of texturedPrimitives(glb, image)) {
    const uvs = prim.uvs!;
    const count = prim.positions.length / 3;
    const ids = new Int32Array(count);
    for (let v = 0; v < count; v++) ids[v] = weld(prim.positions, v);
    for (let t = 0; t + 2 < prim.indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const va = prim.indices[t + e]!;
        const vb = prim.indices[t + ((e + 1) % 3)]!;
        if (va >= count || vb >= count) continue;
        const a = ids[va]!;
        const b = ids[vb]!;
        if (a === b) continue;
        // Oriented by welded id so both triangles list the edge's ends in the same order.
        const flip = a > b;
        const key = flip ? `${b}:${a}` : `${a}:${b}`;
        const [lo, hi] = flip ? [vb, va] : [va, vb];
        const uv = [uvs[lo * 2]!, uvs[lo * 2 + 1]!, uvs[hi * 2]!, uvs[hi * 2 + 1]!];
        const seen = edges.get(key);
        if (!seen) {
          edges.set(key, uv);
        } else if (seen.length === 4) {
          if (
            !same(seen[0]!, seen[1]!, uv[0]!, uv[1]!) ||
            !same(seen[2]!, seen[3]!, uv[2]!, uv[3]!)
          ) {
            compare(seen, uv);
          }
          // Mark the edge as paired so a third triangle does not repeat the comparison.
          edges.set(key, [...seen, 0]);
        }
      }
    }
  }

  if (distances.length === 0) return { edges: 0, mean: 0, p95: 0 };
  distances.sort((x, y) => x - y);
  const mean = distances.reduce((s, d) => s + d, 0) / distances.length;
  const p95 = distances[Math.min(distances.length - 1, Math.floor(0.95 * distances.length))]!;
  return { edges: distances.length, mean, p95 };
}
