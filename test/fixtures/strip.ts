/**
 * Synthetic animation strips drawn in code: a four-legged figure walking, breathing or hopping,
 * in painterly (soft alpha), flat (binary alpha, three colours) or pixel (binary alpha, four
 * colours, 2 px blocks) style. Registered the way a real strip is: feet on the ground line and the
 * centre of mass on the anchor. Nothing here is real art.
 */
import { createRaster, setPixel } from "../../src/image/raster.ts";
import type { Raster } from "../../src/image/raster.ts";
import { joinStrip } from "../../src/animation/strip.ts";
import type { Point, Size } from "../../src/types.ts";

export interface StripOptions {
  count: number;
  frame?: Size;
  style: "painterly" | "flat" | "pixel";
  motion: "walk" | "idle" | "hop";
  /** Horizontal drift in px per frame. */
  drift?: number;
  /** The last frame does not close the cycle: the walk only runs half way round. */
  seamBreak?: boolean;
  /** 1-based frame lifted 4 px off the ground line. */
  floatFrame?: number;
}

type Rgb = [number, number, number];
const PALETTE: Rgb[] = [
  [196, 148, 92],
  [168, 120, 72],
  [120, 84, 52],
  [236, 214, 170],
];

interface Pose {
  lift: number;
  breathe: number;
  swing: number;
}

/** The region and shade at a point of the figure, or undefined outside it. */
function sample(
  x: number,
  y: number,
  h: number,
  p: Pose,
): { part: number; shade: number } | undefined {
  const s = h / 64;
  const ground = h - p.lift;
  const bodyY = ground - 22 * s;
  const legTop = ground - 16 * s;
  const inEllipse = (cx: number, cy: number, rx: number, ry: number) =>
    ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  const shade = (y - (bodyY - 12 * s)) / (30 * s);
  if (inEllipse(0, bodyY, 14 * s, (8 + p.breathe) * s)) return { part: 0, shade };
  if (inEllipse(17 * s, bodyY - 6 * s, 5 * s, 5 * s)) return { part: 1, shade };
  const tops = [-10, -5, 5, 10];
  for (let k = 0; k < 4; k++) {
    if (y < legTop || y > ground) continue;
    const off = (k === 0 || k === 3 ? p.swing : -p.swing) * s;
    const t = (y - legTop) / (ground - legTop);
    const cx = (tops[k] as number) * s + off * t;
    if (Math.abs(x - cx) <= 1.5 * s) return { part: 2, shade };
  }
  return undefined;
}

function colourOf(style: StripOptions["style"], part: number, shade: number): Rgb {
  if (style === "painterly") {
    const base = PALETTE[part] as Rgb;
    const k = 0.85 + 0.3 * Math.min(1, Math.max(0, shade));
    return base.map((c) => Math.min(255, Math.round(c * k))) as Rgb;
  }
  if (style === "flat") return PALETTE[part] as Rgb;
  return PALETTE[shade > 0.6 ? 3 : part] as Rgb;
}

function render(
  width: number,
  height: number,
  style: StripOptions["style"],
  p: Pose,
  ox = 0,
): Raster {
  const out = createRaster(width, height);
  const cx = width / 2 + ox;
  const coarse = style === "pixel" ? 2 : 1;
  const sub = style === "painterly" ? 4 : 1;
  for (let by = 0; by < height; by += coarse) {
    for (let bx = 0; bx < width; bx += coarse) {
      let hits = 0;
      let rgb: Rgb = [0, 0, 0];
      for (let j = 0; j < sub; j++) {
        for (let i = 0; i < sub; i++) {
          const x = bx + (coarse === 1 ? (i + 0.5) / sub : 1) - cx;
          const y = by + (coarse === 1 ? (j + 0.5) / sub : 1);
          const hit = sample(x, y, height, p);
          if (!hit) continue;
          const c = colourOf(style, hit.part, hit.shade);
          rgb = [rgb[0] + c[0], rgb[1] + c[1], rgb[2] + c[2]];
          hits++;
        }
      }
      if (hits === 0) continue;
      const alpha = style === "painterly" ? Math.round((255 * hits) / (sub * sub)) : 255;
      const colour = rgb.map((c) => Math.round(c / hits));
      for (let dy = 0; dy < coarse; dy++) {
        for (let dx = 0; dx < coarse; dx++) setPixel(out, bx + dx, by + dy, [...colour, alpha]);
      }
    }
  }
  return out;
}

function centreOfMassX(r: Raster): number {
  let sum = 0;
  let sx = 0;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const a = r.data[(y * r.width + x) * 4 + 3] as number;
      sum += a;
      sx += a * (x + 0.5);
    }
  }
  return sum > 0 ? sx / sum : 0;
}

function shifted(r: Raster, dx: number): Raster {
  const out = createRaster(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= r.width) continue;
      const from = (y * r.width + sx) * 4;
      out.data.set(r.data.subarray(from, from + 4), (y * r.width + x) * 4);
    }
  }
  return out;
}

export function syntheticStrip(options: StripOptions): {
  frames: Raster[];
  anchor: Point;
  strip: Raster;
} {
  const { count, style, motion } = options;
  const { width, height } = options.frame ?? { width: 64, height: 64 };
  const anchor = { x: width / 2, y: height - 1 };
  const poses: Pose[] = [];
  for (let i = 0; i < count; i++) {
    const turn = options.seamBreak ? Math.PI * (i / (count - 1)) : (2 * Math.PI * i) / count;
    const pose: Pose = { lift: 0, breathe: 0, swing: 0 };
    if (motion === "walk") pose.swing = 4 * Math.cos(turn);
    else if (motion === "idle") pose.breathe = 0.6 * Math.sin(turn);
    else pose.lift = 6 * Math.sin((Math.PI * i) / (count - 1));
    if (options.floatFrame === i + 1) pose.lift += 4;
    poses.push(pose);
  }
  // One shift for the whole strip, from the mean centre of mass, so no frame rounds differently.
  const coms = poses.map((p) => centreOfMassX(render(width, height, style, p)));
  const mean = coms.reduce((a, b) => a + b, 0) / Math.max(1, count);
  const base = anchor.x + 0.5 - mean;
  const frames = poses.map((pose, i) => {
    const drift = Math.round((options.drift ?? 0) * i);
    if (style === "pixel")
      return shifted(render(width, height, style, pose), Math.round(base) + drift);
    return shifted(
      render(width, height, style, pose, base - Math.round(base)),
      Math.round(base) + drift,
    );
  });
  return { frames, anchor, strip: joinStrip(frames) };
}

/**
 * A four-legged walk seen from three-quarters, drawn as blocks: near paws reach the ground line,
 * far paws stop 5 px higher, and each paw is down for three quarters of the cycle (moving back)
 * and lifted 3 px while it swings forward, a quarter cycle after the paw before it. The lowest
 * paw changes from frame to frame and the pattern runs once per cycle, as in a real fox walk.
 * `slide[f]` shifts frame f's legs (1-based) by that many px while the body stays put.
 */
export function quadrupedWalk(
  count: number,
  slide: Record<number, number> = {},
): { frames: Raster[]; frame: Size; anchor: Point } {
  const width = 160;
  const height = 80;
  const anchor = { x: 80, y: 70 };
  const legs = [
    { hip: 60, near: true, phase: 0 },
    { hip: 100, near: true, phase: 0.25 },
    { hip: 60, near: false, phase: 0.5 },
    { hip: 100, near: false, phase: 0.75 },
  ];
  const frames = Array.from({ length: count }, (_, i) => {
    const r = createRaster(width, height);
    const paint = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) setPixel(r, x, y, [90, 80, 70, 255]);
    };
    paint(40, 16, 119, 52);
    for (const leg of legs) {
      const u = (i / count + leg.phase) % 1;
      const down = u < 0.75;
      const reach = down ? 1 - (2 * u) / 0.75 : -1 + (2 * (u - 0.75)) / 0.25;
      const x = Math.round(leg.hip + 14 * reach) + (slide[i + 1] ?? 0);
      paint(x - 3, 50, x + 2, (leg.near ? 70 : 65) - (down ? 0 : 3));
    }
    return r;
  });
  return { frames, frame: { width, height }, anchor };
}
