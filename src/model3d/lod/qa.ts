/**
 * QA of a detail level against the full model (assetforge#136): its triangles within the level's
 * ratio, the same skeleton, skin and clips with every kept vertex's weights and UVs unchanged, and
 * its silhouette in the turntable views and across every clip's frames.
 */
import { isDeepStrictEqual } from "node:util";
import type { Reason } from "../../types.ts";
import { readAccessor } from "../glb.ts";
import type { Glb } from "../glb.ts";
import { FRAMES_PER_CLIP } from "../profile.ts";
import { renderViewWithDepth, TURNTABLE_VIEWS } from "../render.ts";
import { clips, samplePose } from "../scene.ts";
import type { Bounds, Pose } from "../scene.ts";
import type { SimplifiedPrimitive } from "./simplify.ts";

const deterministic = (check: string, passed: boolean, reason: string): Reason => ({
  check,
  passed,
  reason,
  source: "deterministic",
});

/** The views a level is compared in: the four turntable views, then each clip's frames. */
export interface SilhouetteView {
  name: string;
  yawDeg: number;
  clip?: number;
  timeS?: number;
}

export function silhouetteViews(glb: Glb, forwardYawDeg: number): SilhouetteView[] {
  const views: SilhouetteView[] = TURNTABLE_VIEWS.map((v) => ({
    name: v.name,
    yawDeg: forwardYawDeg + v.yawDeg,
  }));
  for (const clip of clips(glb)) {
    for (let i = 0; i < FRAMES_PER_CLIP; i++) {
      views.push({
        name: `${clip.name} frame ${i}`,
        yawDeg: forwardYawDeg + 45,
        clip: clip.index,
        timeS: (i * clip.durationS) / FRAMES_PER_CLIP,
      });
    }
  }
  return views;
}

/** The pixels the model covers in one view (1) and those it does not (0). */
export function silhouette(
  glb: Glb,
  view: SilhouetteView,
  options: { sizePx: number; framing: Bounds; pose?: Pose },
): Uint8Array {
  const { depth } = renderViewWithDepth(glb, {
    sizePx: options.sizePx,
    yawDeg: view.yawDeg,
    framing: options.framing,
    unlit: true,
    ...(options.pose && { pose: options.pose }),
  });
  return Uint8Array.from(depth, (d) => (Number.isFinite(d) ? 1 : 0));
}

/** The pose of a view: its clip at its time, or the rest pose. */
export function viewPose(glb: Glb, view: SilhouetteView): Pose | undefined {
  return view.clip === undefined ? undefined : samplePose(glb, view.clip, view.timeS ?? 0);
}

/** The share of the full model's silhouette that the level covers differently. */
export function silhouetteDifference(full: Uint8Array, level: Uint8Array): number {
  let area = 0;
  let differ = 0;
  for (let i = 0; i < full.length; i++) {
    area += full[i]!;
    if (full[i] !== level[i]) differ++;
  }
  return area === 0 ? (differ === 0 ? 0 : 1) : differ / area;
}

export function trianglesCheck(
  level: number,
  ratio: number,
  triangles: number,
  fullTriangles: number,
): Reason {
  const limit = Math.floor(ratio * fullTriangles);
  const within = triangles <= limit;
  return deterministic(
    `lod-${level}-triangles`,
    within,
    `level ${level}: ${triangles} triangles, ${within ? "within" : "over"} ${limit} ` +
      `(ratio ${ratio} of ${fullTriangles})`,
  );
}

/**
 * Same skeleton, skin, animations and materials as the full model, and every kept vertex's
 * position, skin joints and weights and texture coordinates exactly its source vertex's, so the
 * level deforms with the same weights and lines up with the base colour and side maps.
 */
export function rigCheck(
  full: Glb,
  level: Glb,
  levelIndex: number,
  primitives: SimplifiedPrimitive[],
): Reason {
  const problems: string[] = [];
  const f = full.json;
  const l = level.json;
  // Accessors may be renumbered in a level, so skins and clips are compared by their data.
  const skinShape = (skins: typeof f.skins) =>
    (skins ?? []).map((s) => ({ joints: s.joints, skeleton: s.skeleton }));
  if (!isDeepStrictEqual(skinShape(f.skins), skinShape(l.skins))) problems.push("its skins differ");
  const animations = (glb: Glb) =>
    (glb.json.animations ?? []).map((a) => ({
      name: a.name,
      extras: a["extras"],
      channels: a.channels,
      samplers: a.samplers.map((s) => ({
        interpolation: s.interpolation,
        input: readAccessor(glb, s.input),
        output: readAccessor(glb, s.output),
      })),
    }));
  if (!isDeepStrictEqual(animations(full), animations(level))) {
    problems.push("its animations differ");
  }
  if (!isDeepStrictEqual(f.materials ?? [], l.materials ?? []))
    problems.push("its materials differ");
  const strip = (nodes: typeof f.nodes) =>
    (nodes ?? []).map((n) => {
      const copy = { ...n };
      delete copy.mesh;
      return copy;
    });
  if (!isDeepStrictEqual(strip(f.nodes), strip(l.nodes))) problems.push("its nodes differ");
  for (const [i, skin] of (f.skins ?? []).entries()) {
    const other = l.skins?.[i];
    if (skin.inverseBindMatrices === undefined || other?.inverseBindMatrices === undefined)
      continue;
    const a = readAccessor(full, skin.inverseBindMatrices);
    const b = readAccessor(level, other.inverseBindMatrices);
    if (!isDeepStrictEqual(a, b)) problems.push(`skin ${i}'s inverse bind matrices differ`);
  }
  let vertices = 0;
  let attributes = new Set<string>();
  for (const [n, node] of (f.nodes ?? []).entries()) {
    const levelMesh = l.nodes?.[n]?.mesh;
    if (node.mesh === undefined || levelMesh === undefined) continue;
    for (const [p, primitive] of (f.meshes?.[node.mesh]?.primitives ?? []).entries()) {
      const simplified = primitives.find((s) => s.mesh === node.mesh && s.primitive === p);
      const target = l.meshes?.[levelMesh]?.primitives[p];
      if (!simplified || !target) continue;
      for (const [name, accessor] of Object.entries(primitive.attributes)) {
        if (!/^(POSITION|TEXCOORD_\d+|JOINTS_\d+|WEIGHTS_\d+)$/.test(name)) continue;
        const kept = target.attributes[name];
        if (kept === undefined) {
          problems.push(`mesh ${node.mesh} primitive ${p} lost ${name}`);
          continue;
        }
        attributes.add(name);
        const source = readAccessor(full, accessor);
        const values = readAccessor(level, kept);
        const width = source.length / (f.accessors![accessor]!.count || 1);
        let differ = 0;
        simplified.vertexSources.forEach((from, v) => {
          for (let c = 0; c < width; c++) {
            if (source[from * width + c] !== values[v * width + c]) {
              differ++;
              break;
            }
          }
        });
        if (differ > 0) {
          problems.push(`${differ} vertex(es) of mesh ${node.mesh} primitive ${p} changed ${name}`);
        }
      }
      vertices += simplified.vertexSources.length;
    }
  }
  attributes = new Set([...attributes].sort());
  return deterministic(
    `lod-${levelIndex}-rig`,
    problems.length === 0,
    problems.length === 0
      ? `level ${levelIndex}: same skeleton, skins, clips and materials; ${vertices} kept vertices ` +
          `carry their source's ${[...attributes].join(", ") || "attributes"} unchanged`
      : `level ${levelIndex}: ${problems.slice(0, 5).join("; ")}`,
  );
}

/** Every clip of the full model plays on the level: present by name, same length, samples. */
export function clipsCheck(full: Glb, level: Glb, levelIndex: number): Reason {
  const problems: string[] = [];
  const own = clips(level);
  for (const clip of clips(full)) {
    const match = own.find((c) => c.name === clip.name);
    if (!match) {
      problems.push(`no clip "${clip.name}"`);
      continue;
    }
    if (match.durationS !== clip.durationS) problems.push(`"${clip.name}" changed length`);
    try {
      for (const t of [0, clip.durationS / 2, clip.durationS]) samplePose(level, match.index, t);
    } catch {
      problems.push(`"${clip.name}" does not sample`);
    }
  }
  const names = clips(full).map((c) => c.name);
  return deterministic(
    `lod-${levelIndex}-clips`,
    problems.length === 0,
    problems.length === 0
      ? `level ${levelIndex}: ${names.length} clip(s) play: ${names.join(", ") || "none"}`
      : `level ${levelIndex}: ${problems.join("; ")}`,
  );
}

/** The level's silhouette against the full model's, view by view; the worst must be within. */
export function silhouetteCheck(
  levelIndex: number,
  differences: Array<{ view: string; difference: number }>,
  tolerance: number,
): Reason {
  const worst = differences.reduce(
    (a, b) => (b.difference > a.difference ? b : a),
    differences[0] ?? { view: "none", difference: 0 },
  );
  const mean = differences.reduce((s, d) => s + d.difference, 0) / (differences.length || 1);
  const within = worst.difference <= tolerance;
  const percent = (v: number) => `${(v * 100).toFixed(2)}%`;
  return deterministic(
    `lod-${levelIndex}-silhouette`,
    within,
    `level ${levelIndex}: silhouette differs from the full model's by ${percent(worst.difference)} at worst ` +
      `(${worst.view}), ${percent(mean)} on average over ${differences.length} view(s) and clip frame(s); ` +
      `tolerance ${percent(tolerance)}`,
  );
}
