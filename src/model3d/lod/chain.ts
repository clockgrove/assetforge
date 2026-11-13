/**
 * The detail-level chain and tier renditions a target profile declares, made from one `.glb`
 * (assetforge#136; docs/characters-3d.md, "Detail levels and tiers"). Levels simplify only the
 * index lists, so every kept vertex keeps its skin, UVs and alignment with the textures and side
 * maps. Each level is checked against the full model; a level that fails is left out, with its
 * reason. Then each tier takes the levels within its triangle budget and textures within its size.
 */
import type { Reason } from "../../types.ts";
import { encodePng } from "../../image/raster.ts";
import type { Raster } from "../../image/raster.ts";
import { GLB_MEDIA_TYPE, parseGlb, writeGlb } from "../glb.ts";
import type { Glb } from "../glb.ts";
import { compactBin } from "../lookdev/edit.ts";
import { renderView, TURNTABLE_VIEWS } from "../render.ts";
import { boundsOf, imageSize, measure, posedPrimitives } from "../scene.ts";
import type { Bounds } from "../scene.ts";
import { clipsCheck, rigCheck, silhouette, silhouetteCheck, silhouetteDifference } from "./qa.ts";
import { silhouetteViews, trianglesCheck, viewPose } from "./qa.ts";
import type { LodLevel, ResolvedLods, TierBudget } from "./settings.ts";
import { appendSimplifiedMesh, levelGlb, pruneAccessors, simplifyPrimitives } from "./simplify.ts";
import type { SimplifiedPrimitive } from "./simplify.ts";
import { fitEmbeddedImages, tierSideImages } from "./textures.ts";
import type { SideFile } from "./textures.ts";

export interface LevelRecord extends LodLevel {
  triangles: number;
  passed: boolean;
}

export interface Chain {
  /** The main `.glb`: every passing level inside it (`embedded`), or level 0 alone (`files`). */
  bytes: Uint8Array;
  /** Every file beside it: the source's side files, then level files and tier renditions. */
  sidecars: SideFile[];
  reasons: Reason[];
  /** Renders for the person: each level's turntable views, the levels side by side, each tier. */
  artifacts: Array<{ name: string; bytes: Uint8Array }>;
  levels: LevelRecord[];
  tiers: Array<{ name: string; levels: number[]; textureMaxPx: number; files: string[] }>;
}

interface BuiltLevel extends LevelRecord {
  glb: Glb;
  primitives: SimplifiedPrimitive[];
  renders: Raster[];
}

/** One mesh-carrying node of the scene and the meshes its levels use. */
function meshNodes(glb: Glb): number[] {
  return (glb.json.nodes ?? []).flatMap((n, i) => (n.mesh === undefined ? [] : [i]));
}

/** Removes meshes no node uses, renumbering the rest, then drops data nothing references. */
export function dropUnusedMeshes(glb: Glb): void {
  const json = glb.json;
  const used = [
    ...new Set((json.nodes ?? []).flatMap((n) => (n.mesh === undefined ? [] : [n.mesh]))),
  ];
  used.sort((a, b) => a - b);
  const remap = new Map(used.map((old, i) => [old, i]));
  const meshes = json.meshes ?? [];
  json.meshes = used.map((i) => meshes[i]!);
  for (const node of json.nodes ?? [])
    if (node.mesh !== undefined) node.mesh = remap.get(node.mesh)!;
  pruneAccessors(glb);
  compactBin(glb);
}

const copy = (glb: Glb): Glb => parseGlb(writeGlb(glb));

/**
 * One file holding `levels` (level numbers, first shown nearest) with `MSFT_lod`: each mesh node
 * shows the first level, and names a node per lower level in `MSFT_lod.ids`, with the screen
 * heights in `extras.MSFT_screencoverage`. Lower-level nodes sit outside the scene, as the
 * extension has them, so the scene's bounds and triangles are the first level's.
 */
function embeddedFile(source: Glb, chosen: BuiltLevel[]): Glb {
  const glb = copy(source);
  const json = glb.json;
  for (const n of meshNodes(source)) {
    const node = json.nodes![n]!;
    const sourceMesh = node.mesh!;
    const meshFor = (level: BuiltLevel) =>
      level.level === 0
        ? sourceMesh
        : appendSimplifiedMesh(
            glb,
            sourceMesh,
            level.primitives.filter((p) => p.mesh === sourceMesh),
            level.level,
          );
    const meshes = chosen.map(meshFor);
    node.mesh = meshes[0]!;
    if (chosen.length < 2) continue;
    const ids = chosen.slice(1).map((level, i) => {
      const lodNode = { ...structuredClone(node), mesh: meshes[i + 1]! };
      delete lodNode.children;
      delete lodNode.extensions;
      if (node.name !== undefined) lodNode.name = `${node.name}_lod${level.level}`;
      json.nodes!.push(lodNode);
      return json.nodes!.length - 1;
    });
    node.extensions = { ...node.extensions, MSFT_lod: { ids } };
    node["extras"] = {
      ...(node["extras"] as Record<string, unknown> | undefined),
      MSFT_screencoverage: chosen.map((level) => level.minScreenHeight),
    };
  }
  if (chosen.length > 1) {
    json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), "MSFT_lod"])];
  }
  dropUnusedMeshes(glb);
  return glb;
}

function levelFile(source: Glb, level: BuiltLevel): Glb {
  return level.level === 0 ? copy(source) : copy(level.glb);
}

function sideBySide(images: Raster[]): Raster {
  const height = Math.max(...images.map((i) => i.height));
  const width = images.reduce((s, i) => s + i.width, 0);
  const out: Raster = { width, height, data: new Uint8Array(width * height * 4) };
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

function stacked(images: Raster[]): Raster {
  const width = Math.max(...images.map((i) => i.width));
  const height = images.reduce((n, i) => n + i.height, 0);
  const out: Raster = { width, height, data: new Uint8Array(width * height * 4) };
  let y0 = 0;
  for (const image of images) {
    out.data.set(image.data, y0 * width * 4);
    y0 += image.height;
  }
  return out;
}

function renderViews(glb: Glb, sizePx: number, framing: Bounds, forwardYawDeg: number): Raster[] {
  return TURNTABLE_VIEWS.map((view) =>
    renderView(glb, { sizePx, yawDeg: forwardYawDeg + view.yawDeg, framing }),
  );
}

/** `stevie.groom.summer.length.png` → `stevie.phone.groom.summer.length.png`. */
function tierName(asset: string, tier: string, name: string): string {
  return name.startsWith(`${asset}.`)
    ? `${asset}.${tier}.${name.slice(asset.length + 1)}`
    : `${tier}.${name}`;
}

export async function buildChain(options: {
  source: Glb;
  /** The source's side files, by the names its `images[].uri` use. */
  sides: SideFile[];
  settings: ResolvedLods;
  /** The profile's own budgets: the default tier, which the main file serves. */
  budgets: { triangles: number; textureMaxPx: number };
  assetId: string;
  sizePx: number;
  forwardYawDeg: number;
}): Promise<Chain> {
  const { source, settings, assetId: asset } = options;
  const fullTriangles = measure(source).triangles;
  const framing = boundsOf(posedPrimitives(source))!;
  const reasons: Reason[] = [];
  const artifacts: Chain["artifacts"] = [];

  // 1. Every level, checked against the full model.
  const views = silhouetteViews(source, options.forwardYawDeg);
  const fullMasks = views.map((view) => {
    const pose = viewPose(source, view);
    return silhouette(source, view, { sizePx: options.sizePx, framing, ...(pose && { pose }) });
  });
  const built: BuiltLevel[] = [];
  for (const declared of settings.levels) {
    if (declared.level === 0) {
      built.push({
        ...declared,
        triangles: fullTriangles,
        passed: true,
        glb: source,
        primitives: await simplifyPrimitives(source, 1),
        renders: renderViews(source, options.sizePx, framing, options.forwardYawDeg),
      });
      continue;
    }
    const made = await levelGlb(source, declared.triangleRatio, declared.level);
    const level = parseGlb(writeGlb(made.glb));
    const differences = views.map((view, i) => {
      const pose = viewPose(source, view);
      const mask = silhouette(level, view, {
        sizePx: options.sizePx,
        framing,
        ...(pose && { pose }),
      });
      return { view: view.name, difference: silhouetteDifference(fullMasks[i]!, mask) };
    });
    const checks = [
      trianglesCheck(declared.level, declared.triangleRatio, made.triangles, fullTriangles),
      rigCheck(source, level, declared.level, made.primitives),
      clipsCheck(source, level, declared.level),
      silhouetteCheck(declared.level, differences, settings.silhouette),
    ];
    const passed = checks.every((c) => c.passed);
    // A failing level is filtered from the chain, not the candidate: shadow, with its reason.
    reasons.push(...checks.map((c) => (passed ? c : { ...c, shadow: true as const })));
    if (!passed) {
      reasons.push({
        check: `lod-${declared.level}`,
        passed: true,
        shadow: true,
        reason: `level ${declared.level} is left out of the chain: ${checks
          .filter((c) => !c.passed)
          .map((c) => c.check)
          .join(", ")} failed`,
        source: "deterministic",
      });
    }
    built.push({
      ...declared,
      triangles: made.triangles,
      passed,
      glb: level,
      primitives: made.primitives,
      renders: renderViews(level, options.sizePx, framing, options.forwardYawDeg),
    });
  }
  for (const level of built) {
    level.renders.forEach((raster, v) => {
      artifacts.push({
        name: `lod${level.level}-${TURNTABLE_VIEWS[v]!.name}.png`,
        bytes: encodePng(raster),
      });
    });
  }
  TURNTABLE_VIEWS.forEach((view, v) => {
    artifacts.push({
      name: `lods-${view.name}.png`,
      bytes: encodePng(sideBySide(built.map((level) => level.renders[v]!))),
    });
  });
  // Each level mid-way through every clip, one row per level, so the person sees them deform alike.
  const clipViews = views.filter((v) => v.clip !== undefined && v.name.endsWith("frame 2"));
  if (clipViews.length > 0) {
    const rows = built.map((level) =>
      sideBySide(
        clipViews.map((view) => {
          const pose = viewPose(source, view);
          return renderView(level.glb, {
            sizePx: Math.max(32, Math.round(options.sizePx / 2)),
            yawDeg: view.yawDeg,
            framing,
            ...(pose && { pose }),
          });
        }),
      ),
    );
    artifacts.push({ name: "lods-clips.png", bytes: encodePng(stacked(rows)) });
  }
  const passing = built.filter((level) => level.passed);

  // 2. The default tier: the main file and, for `files`, a file per lower level.
  const sidecars: SideFile[] = [...options.sides];
  const files = settings.packaging === "files";
  const main = files ? copy(source) : embeddedFile(source, passing);
  if (files) {
    for (const level of passing.slice(1)) {
      sidecars.push({
        name: `${asset}.lod${level.level}.glb`,
        bytes: writeGlb(levelFile(source, level)),
        mediaType: GLB_MEDIA_TYPE,
        field: `levels.lod${level.level}`,
        extra: {
          level: level.level,
          triangles: level.triangles,
          triangleRatio: level.triangleRatio,
          minScreenHeight: level.minScreenHeight,
        },
      });
    }
  }

  // 3. Each declared tier: its levels, its textures, its side maps.
  const tiers: Chain["tiers"] = [];
  const sourceTexture = measureTextures(source, options.sides);
  for (const tier of settings.tiers) {
    const result = tierRendition(tier, passing, {
      source,
      sides: options.sides,
      asset,
      files,
      sourceTexture,
      budgets: options.budgets,
    });
    reasons.push(result.reason);
    if (!result.rendition) continue;
    sidecars.push(...result.rendition.sidecars);
    tiers.push({
      name: tier.name,
      levels: result.rendition.levels,
      textureMaxPx: result.rendition.textureMaxPx,
      files: result.rendition.sidecars.map((s) => s.name),
    });
    const first = result.rendition.firstFile;
    if (first) {
      const renders = renderViews(first, options.sizePx, framing, options.forwardYawDeg);
      artifacts.push({
        name: `tier-${tier.name}.png`,
        bytes: encodePng(sideBySide(renders)),
      });
    }
  }
  return {
    bytes: writeGlb(main),
    sidecars,
    reasons,
    artifacts,
    levels: built.map(({ level, triangleRatio, minScreenHeight, triangles, passed }) => ({
      level,
      triangleRatio,
      minScreenHeight,
      triangles,
      passed,
    })),
    tiers,
  };
}

/** The largest image edge, embedded or beside the model. */
function measureTextures(glb: Glb, sides: SideFile[]): number {
  let max = measure(glb).textureMaxPx;
  const referenced = new Set((glb.json.images ?? []).map((i) => i.uri).filter(Boolean));
  for (const side of sides) {
    if (!referenced.has(side.name) && !referenced.has(encodeURIComponent(side.name))) continue;
    const size = sizeOf(side.bytes);
    if (size) max = Math.max(max, size);
  }
  return max;
}

function sizeOf(bytes: Uint8Array): number | undefined {
  const size = imageSize(bytes);
  return size && Math.max(size.width, size.height);
}

function tierRendition(
  tier: TierBudget,
  passing: BuiltLevel[],
  context: {
    source: Glb;
    sides: SideFile[];
    asset: string;
    files: boolean;
    sourceTexture: number;
    budgets: { triangles: number; textureMaxPx: number };
  },
): {
  reason: Reason;
  rendition?: { sidecars: SideFile[]; levels: number[]; textureMaxPx: number; firstFile?: Glb };
} {
  const check = `tier-${tier.name}`;
  let levels = passing.filter((l) => tier.triangles === undefined || l.triangles <= tier.triangles);
  if (tier.lods !== undefined) levels = levels.slice(0, Math.max(tier.lods, 0));
  if (levels.length === 0) {
    return {
      reason: {
        check,
        passed: false,
        reason:
          `tier ${tier.name}: no level is within its ${tier.triangles} triangles ` +
          `(levels: ${passing.map((l) => `${l.level} ${l.triangles}`).join(", ")})`,
        source: "deterministic",
      },
    };
  }
  const resize = tier.textureMaxPx !== undefined && context.sourceTexture > tier.textureMaxPx;
  const sameAsDefault =
    levels.length === passing.length &&
    !resize &&
    tier.fur &&
    (tier.textureMaxPx === undefined || context.budgets.textureMaxPx <= tier.textureMaxPx);
  const levelText = `level(s) ${levels.map((l) => `${l.level} (${l.triangles} triangles)`).join(", ")}`;
  if (sameAsDefault) {
    return {
      reason: {
        check,
        passed: true,
        reason: `tier ${tier.name}: the main file serves it as it is: ${levelText}, textures ${context.sourceTexture} px`,
        source: "deterministic",
      },
      rendition: {
        sidecars: [],
        levels: levels.map((l) => l.level),
        textureMaxPx: context.sourceTexture,
      },
    };
  }
  const glbs: Array<{ glb: Glb; name: string; field: string; extra: Record<string, unknown> }> = [];
  const groups = context.files ? levels.map((l) => [l]) : [levels];
  for (const group of groups) {
    const glb =
      group.length === 1 && context.files
        ? levelFile(context.source, group[0]!)
        : embeddedFile(context.source, group);
    const first = group[0]!;
    const name = context.files
      ? `${context.asset}.${tier.name}.lod${first.level}.glb`
      : `${context.asset}.${tier.name}.glb`;
    const field = context.files
      ? `tiers.${tier.name}.levels.lod${first.level}`
      : `tiers.${tier.name}.model`;
    glbs.push({
      glb,
      name,
      field,
      extra: context.files
        ? {
            level: first.level,
            triangles: first.triangles,
            triangleRatio: first.triangleRatio,
            minScreenHeight: first.minScreenHeight,
          }
        : { levels: group.map((l) => l.level), triangles: first.triangles, lods: group.length },
    });
  }
  const sides = new Map<string, SideFile>();
  let textureMaxPx = 0;
  const problems: string[] = [];
  for (const entry of glbs) {
    if (tier.textureMaxPx !== undefined) fitEmbeddedImages(entry.glb, tier.textureMaxPx);
    const own = tierSideImages(entry.glb, context.sides, {
      ...(tier.textureMaxPx !== undefined && { maxPx: tier.textureMaxPx }),
      fur: tier.fur,
      rename: (name) => tierName(context.asset, tier.name, name),
    });
    for (const side of own) sides.set(side.name, side);
    const measures = measure(entry.glb);
    textureMaxPx = Math.max(textureMaxPx, measures.textureMaxPx);
    for (const key of ["materials", "bones"] as const) {
      const limit = tier[key];
      if (limit !== undefined && measures[key] > limit) {
        problems.push(`${entry.name}: ${key} ${measures[key]} over ${limit}`);
      }
    }
    entry.extra["textureMaxPx"] = measures.textureMaxPx;
  }
  for (const side of sides.values()) {
    const size = sizeOf(side.bytes);
    if (size) textureMaxPx = Math.max(textureMaxPx, size);
  }
  if (tier.textureMaxPx !== undefined && textureMaxPx > tier.textureMaxPx) {
    problems.push(`textures ${textureMaxPx} px over ${tier.textureMaxPx}`);
  }
  const sidecars: SideFile[] = [
    ...glbs.map((g) => ({
      name: g.name,
      bytes: writeGlb(g.glb),
      mediaType: GLB_MEDIA_TYPE,
      field: g.field,
      extra: g.extra,
    })),
    ...[...sides.values()].map((side) => ({
      ...side,
      field: `tiers.${tier.name}.${side.field}`,
    })),
  ];
  const dropped = tier.fur
    ? ""
    : `; it draws no fur, so ${context.sides.length - sides.size} side map(s) are left out`;
  return {
    reason: {
      check,
      passed: problems.length === 0,
      reason:
        problems.length === 0
          ? `tier ${tier.name}: ${levelText}; textures within ${textureMaxPx} px` +
            (tier.textureMaxPx === undefined ? "" : ` (budget ${tier.textureMaxPx})`) +
            dropped
          : `tier ${tier.name}: ${problems.join("; ")}`,
      source: "deterministic",
    },
    rendition: {
      sidecars,
      levels: levels.map((l) => l.level),
      textureMaxPx,
      firstFile: parseGlb(sidecars[0]!.bytes),
    },
  };
}
