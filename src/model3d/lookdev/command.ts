/**
 * `assetforge look-dev`: gives a picked, rigged 3D character a base colour in the target's
 * character look on its own UVs, fur groom maps per season, and eyes that catch light, checks
 * them, and stages the result as a one-candidate run that `pick` hands off (assetforge#82;
 * docs/look-dev.md). The mesh, UVs and rig are never regenerated. Assetforge never approves it.
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Budget } from "../../budget.ts";
import { Caller } from "../../calls.ts";
import { InputError, ProviderError } from "../../errors.ts";
import type { GenerationProvider } from "../../gateway/provider.ts";
import { identityReason, identitySettings, scoreIdentity } from "../../identity.ts";
import type { IdentityScore } from "../../identity.ts";
import { createRaster, decodeImage, encodePng } from "../../image/raster.ts";
import type { Raster } from "../../image/raster.ts";
import { grantOf } from "../../license.ts";
import { writeRun } from "../../loop.ts";
import type { RunRecord, StagedCandidate } from "../../loop.ts";
import {
  DIGITAL_SOURCE_TYPES,
  embedDigitalSourceType,
  metadataStep,
  readDigitalSourceType,
} from "../../metadata.ts";
import type { DigitalSourceType } from "../../metadata.ts";
import { loadReference, sha256, styleNotes, subjectOf } from "../../request.ts";
import {
  IDENTITY_CAST_OPERATION,
  IDENTITY_CHECK_OPERATION,
  LOOKDEV_GROOM_OPERATION,
  LOOKDEV_LOCATE_OPERATION,
  LOOKDEV_MARKINGS_OPERATION,
  LOOKDEV_OPERATION,
} from "../../routes.ts";
import type { Routes } from "../../routes.ts";
import { ledgerFor } from "../../spend.ts";
import type { SpendLedger } from "../../spend.ts";
import type {
  AssetSpec,
  LoadedReference,
  Provenance,
  Reason,
  StyleBible,
  TargetProfile,
} from "../../types.ts";
import { GLB_MEDIA_TYPE, parseGlb, writeGlb } from "../glb.ts";
import type { Glb } from "../glb.ts";
import { CHARACTER_3D_KIND, characterSpec, model3dSettings } from "../profile.ts";
import { budgetChecks, qaPassed, validatorCheck } from "../qa.ts";
import { TURNTABLE_VIEWS, closeUpCamera, renderView, speckle, viewCamera } from "../render.ts";
import type { FurMaps, PreviewLighting, ViewCamera } from "../render.ts";
import { profileSha256 } from "../rig/candidate.ts";
import { declaresRig, loadRig } from "../rig/template.ts";
import type { LoadedRig } from "../rig/template.ts";
import { boundsOf, clips, measure, posedPrimitives, worldMatrices, yawBetween } from "../scene.ts";
import type { Bounds, Vec3 } from "../scene.ts";
import {
  EYE_MATERIAL,
  addExternalImage,
  baseColorImage,
  compactBin,
  nodePositions,
  replaceImage,
  setEmissive,
  splitEyes,
} from "./edit.ts";
import {
  GROOM_REGIONS,
  groomMaps,
  groomMaskCheck,
  markerMask,
  padMask,
  texelRegions,
} from "./groom.ts";
import type { GroomMaps, GroomRegion, GroomSkeleton, SeasonGroom, SurfaceMarker } from "./groom.ts";
import { depthMap, dilate, fillUnseen, projectViews, seamError } from "./project.ts";
import { bakeTexels } from "./texels.ts";
import type { TexelMap } from "./texels.ts";
import {
  compareMarking,
  markingsPrompt,
  markingsReason,
  measureBox,
  parseMarkingsReply,
} from "./markings.ts";
import type { MarkingMeasure } from "./markings.ts";
import { lookdevSettings } from "./settings.ts";
import type { LookdevSettings, PreviewLightingSettings } from "./settings.ts";

export const LOOKDEV_STEP = "lookdev";
/** The groom key used when the profile declares no seasons. */
export const SINGLE_GROOM = "default";

/**
 * The views look-dev restyles and projects back, in the order it restyles them: the four turntable
 * views, the other side, and a high view of the back. The square-on views come first, so each
 * diagonal view continues markings that a square-on view already placed along the body
 * (assetforge#129: restyled before the side, a diagonal view placed markings the side view then
 * redrew elsewhere, and the blend mixed the two).
 */
export const LOOKDEV_VIEWS = [
  { name: "front", yawDeg: 0, elevationDeg: 15 },
  { name: "side", yawDeg: 90, elevationDeg: 15 },
  { name: "other-side", yawDeg: 270, elevationDeg: 15 },
  { name: "back", yawDeg: 180, elevationDeg: 15 },
  { name: "three-quarter", yawDeg: 45, elevationDeg: 15 },
  { name: "other-three-quarter", yawDeg: 315, elevationDeg: 15 },
  { name: "top", yawDeg: 135, elevationDeg: 65 },
] as const;

/** Restyled views are rendered and projected at this edge. */
const VIEW_PX = 1024;
const CLOSE_UP_PX = 512;
const BACKGROUND: [number, number, number] = [216, 216, 216];
/** Texels with less projection than this share keep the colour-matched source texture. */
const MIN_COVERAGE = 0.5;
/** The most speckle (impulse pixels, fur render minus bare render) a fur preview view may show. */
const MAX_FUR_SPECKLE = 0.005;

export interface LookdevOptions {
  /** The picked `.glb` and the provenance it was handed off with. */
  model: { bytes: Uint8Array; path: string };
  provenance: Provenance;
  spec: AssetSpec;
  specDir: string;
  bible: StyleBible;
  bibleDir: string;
  profile: TargetProfile;
  profileDir: string;
  routes: Routes;
  provider: GenerationProvider;
  providerName: string;
  ledger?: SpendLedger;
  runsDir: string;
  /** Overrides the profile's look-dev cap ($3 by default). */
  capUsd?: number;
  runId?: string;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface LookdevPlan {
  capUsd: number;
  calls: Array<{ operation: string; model: string; estimatedCostUsd: number }>;
  estimateUsd: number;
  withinCap: boolean;
  seasons: string[];
}

function seasonsOf(settings: LookdevSettings): string[] {
  return settings.seasons ?? [SINGLE_GROOM];
}

/** The calls one look-dev makes and their estimate, computed without spending anything. */
export function planLookdev(profile: TargetProfile, routes: Routes, capUsd?: number): LookdevPlan {
  model3dSettings(profile);
  const settings = lookdevSettings(profile);
  const cap = capUsd ?? settings.capUsd;
  const calls: LookdevPlan["calls"] = [];
  const add = (operation: string) => {
    const route = routes[operation];
    if (!route) throw new InputError(`no model route for operation "${operation}"`);
    calls.push({ operation, model: route.model, estimatedCostUsd: route.estimatedCostUsd });
  };
  for (let i = 0; i < LOOKDEV_VIEWS.length; i++) add(LOOKDEV_OPERATION);
  add(LOOKDEV_LOCATE_OPERATION);
  for (let i = 0; i < seasonsOf(settings).length; i++) add(LOOKDEV_GROOM_OPERATION);
  // At most one markings call per turntable view: only views with their own turnaround view call.
  for (let i = 0; i < TURNTABLE_VIEWS.length; i++) add(LOOKDEV_MARKINGS_OPERATION);
  const identity = identitySettings(profile);
  if (identity.mode !== "off") {
    add(identity.question === "cast" ? IDENTITY_CAST_OPERATION : "identity");
    if (identity.mode === "enforce") add(IDENTITY_CHECK_OPERATION);
  }
  const estimateUsd = calls.reduce((sum, c) => sum + c.estimatedCostUsd, 0);
  return {
    capUsd: cap,
    calls,
    estimateUsd,
    withinCap: estimateUsd <= cap + 1e-9,
    seasons: seasonsOf(settings),
  };
}

/** Bible references of the subject for the spec's look, each with the view its role names. */
async function subjectReferences(spec: AssetSpec, bible: StyleBible, bibleDir: string) {
  const subject = subjectOf(spec);
  const refs = bible.references.filter(
    (r) =>
      r.subject === subject &&
      r.role !== "perspective" &&
      (r.look === undefined || spec.look === undefined || r.look === spec.look),
  );
  if (refs.length === 0) {
    throw new InputError(`the style bible has no approved references for subject "${subject}"`);
  }
  const loaded = await Promise.all(refs.map((r) => loadReference(r.path, r.role, bibleDir)));
  return loaded.map((r) => ({ ...r, view: viewOf(r.role) }));
}

function viewOf(role: string): string | undefined {
  const r = role.toLowerCase();
  if (r.includes("three-quarter") || r.includes("3/4")) return "three-quarter";
  if (r.includes("front")) return "front";
  if (r.includes("back")) return "back";
  if (r.includes("side") || r.includes("left") || r.includes("right")) return "side";
  return undefined;
}

const AXIS_VECTORS: Record<string, Vec3> = {
  "+z": [0, 0, 1],
  "-z": [0, 0, -1],
  "+x": [1, 0, 0],
  "-x": [-1, 0, 0],
};

function png(bytes: Uint8Array): LoadedReference {
  return { role: "render", path: "(render)", mediaType: "image/png", bytes, sha256: sha256(bytes) };
}

/** Bilinear resize to any width and height (each axis on its own scale). */
export function resize(src: Raster, width: number, height: number): Raster {
  const out = createRaster(width, height);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const v = Math.min(src.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(v);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = v - y0;
    for (let x = 0; x < width; x++) {
      const u = Math.min(src.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(u);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = u - x0;
      for (let c = 0; c < 4; c++) {
        const a = src.data[(y0 * src.width + x0) * 4 + c]!;
        const b = src.data[(y0 * src.width + x1) * 4 + c]!;
        const d = src.data[(y1 * src.width + x0) * 4 + c]!;
        const e = src.data[(y1 * src.width + x1) * 4 + c]!;
        out.data[(y * width + x) * 4 + c] = Math.round(
          (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy,
        );
      }
    }
  }
  return out;
}

/** The bounding box of pixels that differ from the background by more than `tolerance`. */
function foregroundBox(raster: Raster, background: [number, number, number], tolerance = 24) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const { width, height, data } = raster;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const d =
        Math.abs(data[o]! - background[0]) +
        Math.abs(data[o + 1]! - background[1]) +
        Math.abs(data[o + 2]! - background[2]);
      if (d <= tolerance) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return x1 < x0 ? undefined : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * The figure cut out with a margin of `margin` of its larger side, so a vision model boxes markings
 * on the figure at its full resolution rather than on a small figure in a wide frame.
 */
export function figureCrop(
  raster: Raster,
  background: [number, number, number],
  margin = 0.08,
): Raster {
  const box = foregroundBox(raster, background);
  if (!box) return raster;
  const pad = Math.round(Math.max(box.x1 - box.x0, box.y1 - box.y0) * margin);
  const x0 = Math.max(0, box.x0 - pad);
  const y0 = Math.max(0, box.y0 - pad);
  const x1 = Math.min(raster.width, box.x1 + pad);
  const y1 = Math.min(raster.height, box.y1 + pad);
  const out = createRaster(x1 - x0, y1 - y0);
  for (let y = y0; y < y1; y++) {
    out.data.set(
      raster.data.subarray((y * raster.width + x0) * 4, (y * raster.width + x1) * 4),
      (y - y0) * out.width * 4,
    );
  }
  return out;
}

/** The median colour of the image's border: the background an edited image ended up with. */
function borderColour(raster: Raster): [number, number, number] {
  const samples: number[][] = [[], [], []];
  const { width, height, data } = raster;
  const push = (x: number, y: number) => {
    const o = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) samples[c]!.push(data[o + c]!);
  };
  for (let x = 0; x < width; x += 4) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 4) {
    push(0, y);
    push(width - 1, y);
  }
  return samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1]!) as [number, number, number];
}

/**
 * The background an edited view left, as a mask: pixels connected to the image's border whose
 * colour is within `tolerance` of the border colour, grown by `grow` pixels so the anti-aliased
 * fringe of the drawn figure is left out too (one pixel by default). Only border-connected pixels count, so a pale coat
 * inside the figure is never taken for background. With the view's flat `render`, a pixel the render
 * itself draws in the background's colour is kept: there, the model's own surface looks like
 * background, and the edit cannot be told apart from it.
 */
export function editedBackground(
  edited: Raster,
  render?: Raster,
  tolerance = 24,
  grow = 1,
): Uint8Array {
  const { width, height, data } = edited;
  const bg = borderColour(edited);
  const mask = new Uint8Array(width * height);
  const near = (i: number) =>
    Math.abs(data[i * 4]! - bg[0]) +
      Math.abs(data[i * 4 + 1]! - bg[1]) +
      Math.abs(data[i * 4 + 2]! - bg[2]) <=
    tolerance;
  const stack: number[] = [];
  const seed = (i: number) => {
    if (!mask[i] && near(i)) {
      mask[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % width;
    if (x > 0) seed(i - 1);
    if (x < width - 1) seed(i + 1);
    if (i >= width) seed(i - width);
    if (i < (height - 1) * width) seed(i + width);
  }
  let grown = mask;
  for (let ring = 0; ring < grow; ring++) {
    const next = Uint8Array.from(grown);
    for (let i = 0; i < width * height; i++) {
      if (grown[i]) continue;
      const x = i % width;
      if (
        (x > 0 && grown[i - 1]) ||
        (x < width - 1 && grown[i + 1]) ||
        (i >= width && grown[i - width]) ||
        (i < (height - 1) * width && grown[i + width])
      )
        next[i] = 1;
    }
    grown = next;
  }
  if (render && render.width === width && render.height === height) {
    for (let i = 0; i < width * height; i++) {
      if (!grown[i]) continue;
      const o = i * 4;
      const d =
        Math.abs(render.data[o]! - bg[0]) +
        Math.abs(render.data[o + 1]! - bg[1]) +
        Math.abs(render.data[o + 2]! - bg[2]);
      if (d <= tolerance) grown[i] = 0;
    }
  }
  return grown;
}

/**
 * Registers an edited view onto its render: the edit's figure box is scaled and moved onto the
 * render's, so a model that shifted or resized the figure still projects onto the right texels.
 */
export function register(edited: Raster, render: Raster): Raster {
  const size = render.width;
  const sized =
    edited.width === size && edited.height === render.height
      ? edited
      : resize(edited, size, render.height);
  const target = foregroundBox(render, BACKGROUND);
  const source = foregroundBox(sized, borderColour(sized));
  if (!target || !source) return sized;
  const sx = (source.x1 - source.x0) / (target.x1 - target.x0);
  const sy = (source.y1 - source.y0) / (target.y1 - target.y0);
  const out = createRaster(size, render.height);
  for (let y = 0; y < render.height; y++) {
    const v = Math.min(sized.height - 1, Math.max(0, Math.round(source.y0 + (y - target.y0) * sy)));
    for (let x = 0; x < size; x++) {
      const u = Math.min(
        sized.width - 1,
        Math.max(0, Math.round(source.x0 + (x - target.x0) * sx)),
      );
      const from = (v * sized.width + u) * 4;
      const to = (y * size + x) * 4;
      out.data[to] = sized.data[from]!;
      out.data[to + 1] = sized.data[from + 1]!;
      out.data[to + 2] = sized.data[from + 2]!;
      out.data[to + 3] = 255;
    }
  }
  return out;
}

function restylePrompt(
  spec: AssetSpec,
  bible: StyleBible,
  view: string,
  referenceRoles: string[],
  continued = false,
): string {
  const subject = subjectOf(spec);
  const description = bible.subjects?.[subject]?.description;
  return [
    "Repaint the surface colour of this 3D character render so it matches the approved references.",
    `The first image is a flat-lit render (${view} view) of the character's 3D model; the others are its approved references (${referenceRoles.join("; ")}).`,
    ...(continued
      ? [
          "The render already carries colour painted from other views of the same model. Where a marking from that painting shows in this view, keep it where it is and continue it in the same colour; repaint what does not match the references.",
        ]
      : []),
    description ? `Subject: ${subject}, ${description}.` : `Subject: ${subject}.`,
    `Style bible version ${bible.version}:`,
    ...styleNotes(spec, bible).map((n) => `- ${n}`),
    "Keep the exact silhouette, pose, framing, camera and size of the render: change only the colour and texture painted on the surface, so it can be projected back onto the model.",
    "The character's features (its eyes, nose and mouth, and any ears, limbs or tail it has) are where the render has them: keep each one exactly there, even where the model's proportions differ from the references, and do not draw a feature (such as an eye) anywhere the render does not show it.",
    "Identity markings include broad colour regions (a paler or darker underside, limbs, back or face) as well as small marks, bands and rims. Keep every identity marking where the references have it relative to those features: each marking at the same place on the body, with the same shape, size, colour and contrast, and the same number of repeats where a marking repeats along a part. Where a part alternates bands of two colours, give each band the width the references give it against its neighbours (where the darker bands are broader than the paler ones in the references, keep them broader), and end the part in the colour the references end it in. A marking that surrounds or runs from a feature in the references (around an eye or running back from it) does so around or from that feature as the render places it. Do not soften, blur, shrink or blend a marking into the colour around it, and add none the references do not show.",
    "Paint the colour as evenly lit albedo: no cast shadows, no highlights, no rim light, no background objects. Keep the plain background colour.",
    "Paint nothing that stands off the surface, such as whiskers or stray hairs: it is not surface colour, and projected back it would break up the marking under it.",
  ].join("\n");
}

function locatePrompt(): string {
  return [
    "The image is a close-up front render of a 3D character's head, 1:1 pixels.",
    'Reply with JSON only: {"eyes": [{"x": number, "y": number, "r": number}], "nose": {"x": number, "y": number, "r": number} | null}.',
    "x and y are the pixel centre of each eyeball and of the nose leather (the bare tip of the nose), from the top-left corner; r is its radius in pixels.",
    "List every visible eye. Use null for the nose if the character has none.",
  ].join("\n");
}

function groomPrompt(
  spec: AssetSpec,
  bible: StyleBible,
  season: string,
  traits: string | undefined,
  heightM: number,
): string {
  const subject = subjectOf(spec);
  const description = bible.subjects?.[subject]?.description;
  return [
    `The images are the approved references of ${subject}, a real-time 3D game character about ${heightM.toFixed(2)} m tall.`,
    description ? `Description: ${description}.` : "",
    season === SINGLE_GROOM
      ? "Describe its fur groom."
      : `Describe its fur groom in its ${season} coat: ${traits ?? "(no traits given)"}.`,
    `Regions: ${GROOM_REGIONS.join(", ")} (face is the front of the head around the eyes and muzzle; cheek is the side of the head).`,
    'Reply with JSON only: {"lengthMm": {<region>: number}, "density": {<region>: number from 0 to 1}, "tint": {"color": "#rrggbb", "tipWeight": number from 0 to 1} | null}.',
    "lengthMm is the fur length in millimetres. tint is the colour the fur tips are multiplied by where this coat's colour differs from the references; null when it does not.",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseJsonReply(text: string, what: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new ProviderError(`the ${what} reply holds no JSON object`);
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new ProviderError(`the ${what} reply is not valid JSON`);
  }
}

/** One season's groom from the model's reply, clamped to sane ranges. */
export function parseSeasonGroom(text: string): SeasonGroom {
  const reply = parseJsonReply(text, "groom");
  const lengths = (reply["lengthMm"] ?? {}) as Record<string, unknown>;
  const densities = (reply["density"] ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const lengthMm = {} as Record<GroomRegion, number>;
  const density = {} as Record<GroomRegion, number>;
  for (const region of GROOM_REGIONS) {
    lengthMm[region] = Math.min(300, Math.max(0.5, num(lengths[region], 10)));
    density[region] = Math.min(1, Math.max(0.05, num(densities[region], 0.6)));
  }
  const tint = reply["tint"] as { color?: unknown; tipWeight?: unknown } | null | undefined;
  const hex = typeof tint?.color === "string" ? /^#?([0-9a-f]{6})$/i.exec(tint.color) : null;
  return {
    lengthMm,
    density,
    ...(hex && {
      tint: {
        color: [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16) / 255) as [
          number,
          number,
          number,
        ],
        tipWeight: Math.min(1, Math.max(0, num(tint?.tipWeight, 0.5))),
      },
    }),
  };
}

/** Eye and nose points on a camera's depth map: pixel points cast onto the surface. */
export function parseMarkers(
  text: string,
  camera: ViewCamera,
  depth: Float32Array,
): { eyes: SurfaceMarker[]; nose: SurfaceMarker[] } {
  const reply = parseJsonReply(text, "locate");
  const size = camera.sizePx;
  const cast = (p: unknown): SurfaceMarker | undefined => {
    const q = p as { x?: unknown; y?: unknown; r?: unknown } | null;
    if (!q || typeof q.x !== "number" || typeof q.y !== "number") return undefined;
    const r = typeof q.r === "number" && q.r > 0 ? q.r : size / 40;
    // The nearest surface pixel within the marker's radius.
    let best: { d: number; x: number; y: number } | undefined;
    const reach = Math.ceil(Math.max(2, r));
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = Math.round(q.x) + dx;
        const y = Math.round(q.y) + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = depth[y * size + x]!;
        if (!Number.isFinite(d)) continue;
        const off = dx * dx + dy * dy;
        if (!best || off < (best.x - q.x) ** 2 + (best.y - q.y) ** 2) best = { d, x, y };
      }
    }
    if (!best) return undefined;
    const { eye, forward, right, up, focal } = camera;
    const sx = ((best.x + 0.5 - size / 2) * best.d) / focal;
    const sy = (-(best.y + 0.5 - size / 2) * best.d) / focal;
    const point: Vec3 = [
      eye[0] + forward[0] * best.d + right[0] * sx + up[0] * sy,
      eye[1] + forward[1] * best.d + right[1] * sx + up[1] * sy,
      eye[2] + forward[2] * best.d + right[2] * sx + up[2] * sy,
    ];
    return { point, radius: (r * best.d) / focal };
  };
  const eyes = (Array.isArray(reply["eyes"]) ? reply["eyes"] : [])
    .map(cast)
    .filter((m): m is SurfaceMarker => m !== undefined);
  const nose = [cast(reply["nose"])].filter((m): m is SurfaceMarker => m !== undefined);
  return { eyes, nose };
}

/**
 * Paints a soft catch-light into each eye of a texture on the model's UVs: a small near-white
 * spot on the eye's surface, offset from its centre toward the key light (above, in front, to the
 * character's left, as the turntable light). Changes only texels inside the eye markers. Look-dev
 * paints it into the eye material's own emissive texture, never into the base colour.
 */
export function paintCatchLights(
  albedo: Raster,
  texels: TexelMap,
  eyes: SurfaceMarker[],
  forward: Vec3,
): number {
  const left: Vec3 = [forward[2], 0, -forward[0]];
  const l = [0.8 * 0 + 0.6 * forward[0] + 0.3 * left[0], 0.8, 0.6 * forward[2] + 0.3 * left[2]];
  const ll = Math.hypot(l[0]!, l[1]!, l[2]!);
  const light: Vec3 = [l[0]! / ll, l[1]! / ll, l[2]! / ll];
  let painted = 0;
  const size = texels.size;
  for (const eye of eyes) {
    // The eye's outward normal: the mean normal of its texels.
    const n: Vec3 = [0, 0, 0];
    const inside: number[] = [];
    for (let i = 0; i < size * size; i++) {
      if (!texels.covered[i]) continue;
      const dx = texels.position[i * 3]! - eye.point[0];
      const dy = texels.position[i * 3 + 1]! - eye.point[1];
      const dz = texels.position[i * 3 + 2]! - eye.point[2];
      if (dx * dx + dy * dy + dz * dz > eye.radius * eye.radius) continue;
      inside.push(i);
      for (let k = 0; k < 3; k++) n[k]! += texels.normal[i * 3 + k]!;
    }
    const nl = Math.hypot(...n);
    if (inside.length === 0 || nl === 0) continue;
    const normal: Vec3 = [n[0] / nl, n[1] / nl, n[2] / nl];
    const along = light[0] * normal[0] + light[1] * normal[1] + light[2] * normal[2];
    const t: Vec3 = [
      light[0] - normal[0] * along,
      light[1] - normal[1] * along,
      light[2] - normal[2] * along,
    ];
    const tl = Math.hypot(...t) || 1;
    const centre: Vec3 = [
      eye.point[0] + (t[0] / tl) * eye.radius * 0.35,
      eye.point[1] + (t[1] / tl) * eye.radius * 0.35,
      eye.point[2] + (t[2] / tl) * eye.radius * 0.35,
    ];
    const r = eye.radius * 0.3;
    for (const i of inside) {
      const d = Math.hypot(
        texels.position[i * 3]! - centre[0],
        texels.position[i * 3 + 1]! - centre[1],
        texels.position[i * 3 + 2]! - centre[2],
      );
      if (d >= r) continue;
      const w = 0.92 * (1 - (d / r) ** 2);
      for (let c = 0; c < 3; c++) {
        const o = i * 4 + c;
        albedo.data[o] = Math.round(albedo.data[o]! * (1 - w) + 250 * w);
      }
      painted++;
    }
  }
  return painted;
}

/** The groom skeleton from the skin and, when the target declares one, its rig template. */
function groomSkeleton(glb: Glb, rig: LoadedRig | undefined, forward: Vec3): GroomSkeleton {
  const json = glb.json;
  const skin = json.skins?.[0];
  const world = worldMatrices(json);
  const roles = new Map(rig?.template.joints.map((j) => [j.name, j.role]) ?? []);
  const feet = new Set(rig?.template.feet.flatMap((f) => f.joints) ?? []);
  const parentOf = new Map<number, number>();
  for (const [i, node] of (json.nodes ?? []).entries()) {
    for (const c of node.children ?? []) parentOf.set(c, i);
  }
  const joints = (skin?.joints ?? []).map((node) => {
    const name = json.nodes?.[node]?.name ?? `joint-${node}`;
    const m = world.get(node);
    const parentNode = parentOf.get(node);
    const role = roles.get(name);
    return {
      name,
      parent: parentNode === undefined ? -1 : skin!.joints.indexOf(parentNode),
      position: (m ? [m[12]!, m[13]!, m[14]!] : [0, 0, 0]) as Vec3,
      ...(role !== undefined && { role }),
      ...(feet.has(name) && { foot: true }),
    };
  });
  return { joints, forward };
}

/** The focus of the close-up: the centre of the head region, else the top front of the bounds. */
function headFocus(texels: TexelMap, regions: Uint8Array, bounds: Bounds, forward: Vec3): Vec3 {
  const head = new Set(
    ["face", "cheek", "head"].map((r) => GROOM_REGIONS.indexOf(r as GroomRegion)),
  );
  const sum: Vec3 = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < regions.length; i++) {
    if (!texels.covered[i] || !head.has(regions[i]!)) continue;
    sum[0] += texels.position[i * 3]!;
    sum[1] += texels.position[i * 3 + 1]!;
    sum[2] += texels.position[i * 3 + 2]!;
    n++;
  }
  if (n > 0) return [sum[0] / n, sum[1] / n, sum[2] / n];
  const { min, max } = bounds;
  const c: Vec3 = [(min[0] + max[0]) / 2, min[1] + (max[1] - min[1]) * 0.75, (min[2] + max[2]) / 2];
  const reach = Math.max(max[0] - min[0], max[2] - min[2]) * 0.4;
  return [c[0] + forward[0] * reach, c[1], c[2] + forward[2] * reach];
}

function sideBySide(images: Raster[], height: number): Raster {
  const scaled = images.map((r) =>
    r.height === height
      ? r
      : resize(r, Math.max(1, Math.round((r.width * height) / r.height)), height),
  );
  const width = scaled.reduce((s, r) => s + r.width, 0);
  const out = createRaster(width, height);
  let x0 = 0;
  for (const image of scaled) {
    for (let y = 0; y < height; y++) {
      out.data.set(
        image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
        (y * width + x0) * 4,
      );
    }
    x0 += image.width;
  }
  return out;
}

/** The share of pixels that differ between two same-size renders. */
function changedShare(a: Raster, b: Raster): number {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i]! - b.data[i]!) +
        Math.abs(a.data[i + 1]! - b.data[i + 1]!) +
        Math.abs(a.data[i + 2]! - b.data[i + 2]!) >
      12
    )
      changed++;
  }
  return changed / (a.width * a.height);
}

/** Whether the close-up shows a catch-light in every located eye: a near-white highlight inside it. */
export function catchLight(
  render: Raster,
  camera: ViewCamera,
  eyes: SurfaceMarker[],
): { found: boolean; peak: number; eyes: number } {
  let peak = 0;
  let found = 0;
  for (const eye of eyes) {
    const [cx, cy, depth] = camera.project(...eye.point);
    const r = Math.max(2, (eye.radius * camera.focal) / depth);
    let max = 0;
    let sum = 0;
    let n = 0;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x < 0 || y < 0 || x >= render.width || y >= render.height) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const o = (y * render.width + x) * 4;
        const l =
          0.2126 * render.data[o]! + 0.7152 * render.data[o + 1]! + 0.0722 * render.data[o + 2]!;
        max = Math.max(max, l);
        sum += l;
        n++;
      }
    }
    if (n === 0) continue;
    peak = Math.max(peak, max);
    if (max >= 200 && max - sum / n >= 60) found++;
  }
  return { found: eyes.length > 0 && found === eyes.length, peak: Math.round(peak), eyes: found };
}

function greyMask(mask: Uint8Array, size: number): Raster {
  const out = createRaster(size, size);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 255 : 0;
    out.data[i * 4] = v;
    out.data[i * 4 + 1] = v;
    out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

const round = (v: number, places = 6) => Math.round(v * 10 ** places) / 10 ** places;

/** Mean luminance of the pixels that differ from the background in `mask` (the figure). */
function figureLuminance(raster: Raster, mask: Raster): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < raster.data.length; i += 4) {
    if (
      Math.abs(mask.data[i]! - BACKGROUND[0]) +
        Math.abs(mask.data[i + 1]! - BACKGROUND[1]) +
        Math.abs(mask.data[i + 2]! - BACKGROUND[2]) <=
      6
    )
      continue;
    sum += 0.2126 * raster.data[i]! + 0.7152 * raster.data[i + 1]! + 0.0722 * raster.data[i + 2]!;
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * The run's preview lighting. With `exposure: "auto"`, one exposure for the whole run: the one
 * that brings the source model's mean lit luminance over the four turntable views to its unlit
 * (albedo) luminance. It depends on the source model alone, so before and after share it.
 */
function resolveLighting(
  settings: PreviewLightingSettings,
  render: (lighting: PreviewLighting | undefined, unlit: boolean, view: number) => Raster,
): PreviewLighting {
  const lighting: PreviewLighting = {
    ambient: settings.ambient,
    key: settings.key,
    keyDirection: settings.keyDirection,
    exposure: 1,
  };
  if (settings.exposure !== "auto") return { ...lighting, exposure: settings.exposure };
  let lit = 0;
  let unlit = 0;
  for (let v = 0; v < TURNTABLE_VIEWS.length; v++) {
    const albedo = render(undefined, true, v);
    lit += figureLuminance(render(lighting, false, v), albedo);
    unlit += figureLuminance(albedo, albedo);
  }
  return { ...lighting, exposure: lit > 0 ? unlit / lit : 1 };
}

interface Sidecar {
  name: string;
  field: string;
  bytes: Uint8Array;
  extra?: Record<string, unknown>;
}

export async function lookDev(
  options: LookdevOptions,
): Promise<{ run: RunRecord; runDir: string; passed: boolean; plan: LookdevPlan }> {
  const { spec, profile, provenance, bible } = options;
  if (spec.kind !== CHARACTER_3D_KIND) {
    throw new InputError(`look-dev needs a ${CHARACTER_3D_KIND} spec, not "${spec.kind}"`);
  }
  characterSpec(spec);
  const settings = model3dSettings(profile);
  const look = lookdevSettings(profile);
  if (!provenance || typeof provenance !== "object" || !Array.isArray(provenance.calls)) {
    throw new InputError("the provenance file is not an Assetforge provenance record");
  }
  const plan = planLookdev(profile, options.routes, options.capUsd);
  const log = options.log ?? (() => {});
  const references = await subjectReferences(spec, bible, options.bibleDir);
  const rig = declaresRig(profile) ? await loadRig(profile, options.profileDir) : undefined;

  const sourceSha256 = sha256(options.model.bytes);
  const glb = parseGlb(options.model.bytes);
  const textured = baseColorImage(glb.json);
  if (!textured) throw new InputError("the model has no base-colour texture to look-dev");
  const sourceImage = glb.json.images?.[textured.image];
  if (sourceImage?.bufferView === undefined) {
    throw new InputError("the model's base-colour image is not embedded in the .glb");
  }
  const view = glb.json.bufferViews![sourceImage.bufferView]!;
  const sourceTexture = decodeImage(
    glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength),
  );
  const framing = boundsOf(posedPrimitives(glb));
  if (!framing) throw new InputError("the model has no triangle geometry");
  const heightM = framing.max[1] - framing.min[1];
  const facingDeg = (yawBetween("+z", settings.forward) * 180) / Math.PI;
  const forward = AXIS_VECTORS[settings.forward]!;
  const textureSize = Math.min(
    Math.max(sourceTexture.width, sourceTexture.height),
    settings.budgets.textureMaxPx,
  );
  const groomSize = look.sizePx ?? textureSize;

  // Spend: the whole forecast must fit the cap and the cross-run limits before the first call.
  const budget = new Budget(plan.capUsd, ledgerFor(options.ledger, options.providerName, profile));
  budget.check(plan.estimateUsd, "a look-dev of one character");
  const caller = new Caller({
    provider: options.provider,
    providerName: options.providerName,
    budget,
    routes: options.routes,
    ...(options.now && { now: options.now }),
    log,
  });

  // The run directory exists before the first call, so a run that stops part-way keeps the
  // views it already paid for.
  const now = options.now ?? (() => new Date());
  const runId =
    options.runId ??
    `${now().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = resolve(options.runsDir, runId);
  const id = "c1";
  const dir = `${id}-${CHARACTER_3D_KIND}`;
  await mkdir(join(runDir, dir), { recursive: true });

  const texels = bakeTexels(glb, textureSize, textured.image);
  const skeleton = groomSkeleton(glb, rig, forward);
  const regions = texelRegions(texels, skeleton);
  const focus = headFocus(texels, regions, framing, forward);
  const zoom = look.closestZoom;
  const closeUp = (yawDeg: number) =>
    closeUpCamera({
      sizePx: CLOSE_UP_PX,
      yawDeg: facingDeg + yawDeg,
      focus,
      heightM,
      screenHeightPx: zoom.screenHeightPx,
      characterScreenFraction: zoom.characterScreenFraction,
    });

  // One preview lighting for every before and after render, every season.
  const turntablePx = settings.turntablePx;
  const lighting = resolveLighting(look.previewLighting, (l, unlit, v) =>
    renderView(glb, {
      sizePx: turntablePx,
      yawDeg: facingDeg + TURNTABLE_VIEWS[v]!.yawDeg,
      framing,
      ...(l && { lighting: l }),
      unlit,
    }),
  );
  const unlitView = (model: Glb, v: number) =>
    renderView(model, {
      sizePx: turntablePx,
      yawDeg: facingDeg + TURNTABLE_VIEWS[v]!.yawDeg,
      framing,
      unlit: true,
    });

  // Before: the turntable views and the close-up of the model as picked.
  const beforeViews = TURNTABLE_VIEWS.map((v) =>
    renderView(glb, { sizePx: turntablePx, yawDeg: facingDeg + v.yawDeg, framing, lighting }),
  );
  const unlitBefore = TURNTABLE_VIEWS.map((_, i) => unlitView(glb, i));
  const beforeClose = renderView(glb, {
    sizePx: CLOSE_UP_PX,
    yawDeg: 0,
    framing,
    camera: closeUp(0),
    lighting,
  });

  // 1. Albedo: restyle flat-lit renders and project them back onto the UVs. The views are
  // restyled in turn: each later view starts from the model carrying what the earlier views
  // painted, so it extends their markings instead of placing its own (assetforge#122: restyled
  // independently, the side view put the eye mask where the three-quarter view put pale coat,
  // and the blend averaged the two to grey).
  const source =
    sourceTexture.width === textureSize && sourceTexture.height === textureSize
      ? sourceTexture
      : resize(sourceTexture, textureSize, textureSize);
  const projected = [];
  const depths: Float32Array[] = [];
  const viewArtifacts: Array<{ name: string; bytes: Uint8Array }> = [];
  let painted = glb;
  for (const [k, v] of LOOKDEV_VIEWS.entries()) {
    const camera = viewCamera({
      sizePx: VIEW_PX,
      yawDeg: facingDeg + v.yawDeg,
      framing,
      elevationDeg: v.elevationDeg,
    });
    const flat = renderView(painted, {
      sizePx: VIEW_PX,
      yawDeg: facingDeg + v.yawDeg,
      framing,
      camera,
      unlit: true,
      background: BACKGROUND,
    });
    const flatPng = encodePng(flat);
    const viewName = v.name.replace(/^other-/, "").replace(/^top$/, "back");
    const matching = references.filter((r) => r.view === viewName);
    const refs = [...matching, ...references.filter((r) => !matching.includes(r))].slice(0, 3);
    const edited = await caller.image(
      LOOKDEV_OPERATION,
      restylePrompt(
        spec,
        bible,
        v.name,
        refs.map((r) => r.role),
        k > 0,
      ),
      [{ ...png(flatPng), role: `flat-lit render, ${v.name} view` }, ...refs],
    );
    const aligned = register(decodeImage(edited.bytes), flat);
    projected.push({ camera, image: aligned, background: editedBackground(aligned, flat) });
    depths.push(depthMap(glb, camera));
    if (k < LOOKDEV_VIEWS.length - 1) {
      const sofar = projectViews(glb, texels, projected, depths);
      painted = parseGlb(options.model.bytes);
      replaceImage(
        painted,
        textured.image,
        encodePng(dilate(fillUnseen(sofar, texels, source), texels.covered, 8)),
      );
    }
    viewArtifacts.push(
      { name: `lookdev-view-${v.name}-render.png`, bytes: flatPng },
      { name: `lookdev-view-${v.name}-restyled.png`, bytes: encodePng(aligned) },
    );
    for (const a of viewArtifacts.slice(-2)) await writeFile(join(runDir, dir, a.name), a.bytes);
    log(`look-dev: restyled the ${v.name} view`);
  }
  const projection = projectViews(glb, texels, projected, depths);
  const albedo = dilate(fillUnseen(projection, texels, source), texels.covered, 8);
  const albedoPng = encodePng(albedo);

  // The new albedo goes into the model before the eyes and close-ups are made.
  replaceImage(glb, textured.image, albedoPng);

  // 2. Eyes and nose: located on a close-up front render, cast onto the surface.
  const locateCamera = closeUp(0);
  const locateRender = renderView(glb, {
    sizePx: CLOSE_UP_PX,
    yawDeg: 0,
    framing,
    camera: locateCamera,
    lighting,
  });
  const locateText = await caller.vision(LOOKDEV_LOCATE_OPERATION, locatePrompt(), [
    { ...png(encodePng(locateRender)), role: "close-up front render" },
  ]);
  let markers: { eyes: SurfaceMarker[]; nose: SurfaceMarker[] };
  try {
    markers = parseMarkers(locateText, locateCamera, depthMap(glb, locateCamera));
  } catch {
    markers = { eyes: [], nose: [] };
  }

  // 3. Groom: bare masks, then each season's maps.
  const groomTexels =
    groomSize === textureSize ? texels : bakeTexels(glb, groomSize, textured.image);
  const groomRegions = groomTexels === texels ? regions : texelRegions(groomTexels, skeleton);
  const eyeMask = markerMask(groomTexels, markers.eyes);
  const noseMask = markerMask(groomTexels, markers.nose);
  const world = worldMatrices(glb.json);
  const joints = nodePositions(glb, world);
  const feet = (rig?.template.feet ?? [])
    .map((f) => ({ ankle: joints.get(f.joints[2]), toe: joints.get(f.joints[3]) }))
    .filter((f): f is { ankle: Vec3; toe: Vec3 } => f.ankle !== undefined && f.toe !== undefined);
  const padRadius =
    feet.length > 0
      ? Math.max(
          ...feet.map(
            (f) => Math.hypot(f.toe[0] - f.ankle[0], f.toe[2] - f.ankle[2]) * 0.75 + 0.005,
          ),
        )
      : 0;
  const pads = padMask(groomTexels, feet, padRadius);
  const bare = new Uint8Array(eyeMask.length);
  const count = (m: Uint8Array) =>
    m.reduce((s, v, i) => s + (v && groomTexels.covered[i] ? 1 : 0), 0);
  for (let i = 0; i < bare.length; i++) bare[i] = eyeMask[i] || noseMask[i] || pads[i] ? 1 : 0;
  // Each bare mask on its own: an empty one means that part has fur nobody checked.
  const bareCounts = { eyes: count(eyeMask), nose: count(noseMask), "paw pads": count(pads) };
  const emptyMasks = Object.entries(bareCounts)
    .filter(([, n]) => n === 0)
    .map(([name]) => name);
  const tooSmall = `no texel of the ${groomSize} px groom maps falls inside it`;
  const whyEmpty: Record<string, string> = {
    eyes: markers.eyes.length > 0 ? tooSmall : "the locate call found no eye",
    nose: markers.nose.length > 0 ? tooSmall : "the locate call found no nose",
    "paw pads": rig
      ? "no texel faces down under the rig template's feet"
      : "the profile declares no rig template, so the feet are unknown",
  };

  const reasons: Reason[] = [];
  const sidecars: Sidecar[] = [];
  const asset = spec.assetId;
  const seasonGrooms: Record<string, SeasonGroom> = {};
  const seasonMaps: Record<string, GroomMaps> = {};
  const groomReferences = references.slice(0, 4);
  for (const season of plan.seasons) {
    const text = await caller.vision(
      LOOKDEV_GROOM_OPERATION,
      groomPrompt(spec, bible, season, look.traits[season], heightM),
      groomReferences,
    );
    const groom = parseSeasonGroom(text);
    seasonGrooms[season] = groom;
    const maps = groomMaps(groomTexels, groomRegions, bare, groom, skeleton, albedo);
    seasonMaps[season] = maps;
    const check = groomMaskCheck(maps.length, groomTexels, bare);
    const label = look.seasons ? `groom-${season}-masks` : "groom-masks";
    reasons.push({
      check: label,
      passed: check.ok && emptyMasks.length === 0,
      reason:
        `bare masks: ${Object.entries(bareCounts)
          .map(([name, n]) => `${name} ${n}`)
          .join(", ")} texel(s); ` +
        `${check.zeroOnBare} bare texel(s) with fur and ${check.zeroOutside} zero-length texel(s) outside the masks` +
        emptyMasks
          .map(
            (m) => `; the ${m} mask is empty (${whyEmpty[m]}), so zero length there is unchecked`,
          )
          .join(""),
      source: "deterministic",
    });
    const key = look.seasons ? `${season}.` : "";
    for (const map of look.maps) {
      sidecars.push({
        name: `${asset}.groom.${key}${map}.png`,
        field: `groom.${key}${map}`,
        bytes: encodePng(maps[map]),
        ...(map === "length" && { extra: { maxLengthM: round(maps.maxLengthM) } }),
      });
    }
    if (maps.tint && look.seasons) {
      sidecars.push({
        name: `${asset}.tint.${season}.png`,
        field: `textures.tint.${season}`,
        bytes: encodePng(maps.tint),
      });
    }
  }

  // 4. The eye material and its mask.
  const eyeTriangles = splitEyes(glb, textured.material, markers.eyes);
  // The catch-light lives in the eye material alone, as its emissive texture, so the eyes read as
  // wet at the closest zoom whatever the eye geometry, while the base colour stays unlit albedo.
  // The target can keep it, or drop it and shade the eyes itself; the glossy eye material adds
  // the live highlight.
  if (eyeTriangles > 0) {
    const catchLightTexture = createRaster(textureSize, textureSize);
    for (let i = 3; i < catchLightTexture.data.length; i += 4) catchLightTexture.data[i] = 255;
    paintCatchLights(catchLightTexture, texels, markers.eyes, forward);
    setEmissive(glb, EYE_MATERIAL, encodePng(catchLightTexture), "eyes.catchLight");
  }
  const eyeMaskTexture = markerMask(texels, markers.eyes);
  sidecars.push({
    name: `${asset}.eyes.mask.png`,
    field: "eyes",
    bytes: encodePng(greyMask(eyeMaskTexture, textureSize)),
    extra: { material: EYE_MATERIAL },
  });
  sidecars.push({ name: `${asset}.baseColor.png`, field: "textures.baseColor", bytes: albedoPng });

  // Budgets are measured on the embedded model; the external maps are checked by their own size.
  compactBin(glb);
  const embeddedMeasures = measure(parseGlb(writeGlb(glb)));

  // External images: the groom maps, tints and eye mask beside the .glb, never embedded.
  const groomExtras: Record<string, unknown> = {};
  for (const s of sidecars) {
    if (s.field === "textures.baseColor") continue;
    const index = addExternalImage(glb.json, s.name, s.field);
    groomExtras[s.field] = { image: index, uri: s.name };
  }
  glb.json.asset.extras = {
    ...(glb.json.asset.extras as Record<string, unknown> | undefined),
    lookdev: {
      groom: {
        encoding: {
          length: "grey, 0 = no fur, 255 = maxLengthM",
          direction: "rest-pose model-space comb direction, rgb = d * 0.5 + 0.5",
          density: "grey, 0..1 of the material's strand density",
          tint: "rgb multiplies the base colour, alpha weights it toward the fur tips",
        },
        maxLengthM: Object.fromEntries(
          Object.entries(seasonMaps).map(([s, m]) => [s, round(m.maxLengthM)]),
        ),
      },
      images: groomExtras,
      eyes: { material: EYE_MATERIAL, catchLight: "the eye material's emissiveTexture" },
    },
  };
  const raw = writeGlb(glb);
  const written = parseGlb(raw);
  const measures = {
    ...embeddedMeasures,
    textureMaxPx: Math.max(embeddedMeasures.textureMaxPx ?? 0, groomSize),
  };

  // 5. After: per season, turntables with map-driven shell fur, and the close-up.
  const artifacts: Array<{ name: string; bytes: Uint8Array }> = [...viewArtifacts];
  const afterBySeason: Record<string, Raster[]> = {};
  const afterClose: Record<string, Raster> = {};
  const unlitAfter = TURNTABLE_VIEWS.map((_, i) => unlitView(written, i));
  const litToUnlit: Record<string, Record<string, number>> = {};
  const furSpeckle: Record<string, Record<string, number>> = {};
  for (const season of plan.seasons) {
    const maps = seasonMaps[season]!;
    const fur: FurMaps = {
      length: maps.length,
      direction: maps.direction,
      density: maps.density,
      ...(maps.tint && { tint: maps.tint }),
      maxLengthM: maps.maxLengthM,
      // About one strand per two texels of the maps, so strands stay finer than a pixel at the closest zoom.
      strandsPerUv: Math.max(192, Math.round(groomSize / 2)),
    };
    const bare = TURNTABLE_VIEWS.map((v) =>
      renderView(written, {
        sizePx: turntablePx,
        yawDeg: facingDeg + v.yawDeg,
        framing,
        lighting,
      }),
    );
    const views = TURNTABLE_VIEWS.map((v) =>
      renderView(written, {
        sizePx: turntablePx,
        yawDeg: facingDeg + v.yawDeg,
        framing,
        fur,
        lighting,
      }),
    );
    afterBySeason[season] = views;
    const bareClose = renderView(written, {
      sizePx: CLOSE_UP_PX,
      yawDeg: 0,
      framing,
      camera: closeUp(0),
      lighting,
    });
    afterClose[season] = renderView(written, {
      sizePx: CLOSE_UP_PX,
      yawDeg: 0,
      framing,
      camera: closeUp(0),
      fur,
      lighting,
    });
    litToUnlit[season] = Object.fromEntries(
      TURNTABLE_VIEWS.map((v, i) => [
        v.name,
        round(
          figureLuminance(views[i]!, unlitAfter[i]!) /
            Math.max(1e-6, figureLuminance(unlitAfter[i]!, unlitAfter[i]!)),
          3,
        ),
      ]),
    );
    // Speckle the fur adds over the bare surface, in every view and the close-up.
    const speckles: Record<string, number> = {};
    TURNTABLE_VIEWS.forEach((v, i) => {
      speckles[v.name] = Math.max(0, speckle(views[i]!) - speckle(bare[i]!));
    });
    speckles["close-up"] = Math.max(0, speckle(afterClose[season]) - speckle(bareClose));
    furSpeckle[season] = Object.fromEntries(
      Object.entries(speckles).map(([k, v]) => [k, round(v, 5)]),
    );
    const worst = Object.entries(speckles).reduce((a, b) => (b[1] > a[1] ? b : a));
    const share = Math.max(...views.map((v, i) => changedShare(v, bare[i]!)));
    reasons.push({
      check: look.seasons ? `groom-${season}-render` : "groom-render",
      passed: share > 0.01 && worst[1] <= MAX_FUR_SPECKLE,
      reason:
        `shell fur driven by the maps changes ${(share * 100).toFixed(1)}% of the pixels of a turntable view; ` +
        `speckle it adds: at most ${(worst[1] * 100).toFixed(2)}% of the figure's pixels (${worst[0]}; limit ${(MAX_FUR_SPECKLE * 100).toFixed(1)}%)`,
      source: "deterministic",
    });
  }

  // Checks on the albedo.
  reasons.push({
    check: "lookdev-albedo-coverage",
    passed: projection.coverage >= MIN_COVERAGE,
    reason: `${(projection.coverage * 100).toFixed(1)}% of the texels take colour from the restyled views; the rest keep the source texture, colour-matched`,
    source: "deterministic",
  });
  const seamsBefore = seamError(parseGlb(options.model.bytes), source, textured.image);
  const seamsAfter = seamError(written, albedo, textured.image);
  reasons.push({
    check: "lookdev-seams",
    passed: seamsAfter.mean <= Math.max(8, seamsBefore.mean * 1.25),
    reason:
      `colour difference across ${seamsAfter.edges} UV seam edge(s): mean ${seamsAfter.mean.toFixed(1)}, ` +
      `95th percentile ${seamsAfter.p95.toFixed(1)} (0-255; the source texture: mean ${seamsBefore.mean.toFixed(1)}, ` +
      `95th percentile ${seamsBefore.p95.toFixed(1)})`,
    source: "deterministic",
  });
  const eyesClose = renderView(written, {
    sizePx: CLOSE_UP_PX,
    yawDeg: 0,
    framing,
    camera: closeUp(0),
    lighting,
  });
  const light = catchLight(eyesClose, closeUp(0), markers.eyes);
  reasons.push({
    check: "eyes-catch-light",
    passed: eyeTriangles > 0 && light.found,
    reason:
      `${markers.eyes.length} eye(s) located, ${eyeTriangles} triangle(s) in the "${EYE_MATERIAL}" material; ` +
      `catch-light in ${light.eyes} of ${markers.eyes.length} eye(s) of the close-up at the closest zoom ` +
      `(peak luminance ${light.peak}; the catch-light is the eye material's emissive texture, the base colour has none)`,
    source: "deterministic",
  });
  reasons.push(
    await validatorCheck(raw, Object.fromEntries(sidecars.map((s) => [s.name, s.bytes]))),
  );
  reasons.push(...budgetChecks(measures, settings));

  // Markings: each identity marking in the lit after renders against the matching turnaround view.
  const markingMeasures: MarkingMeasure[] = [];
  const unmeasured: string[] = [];
  const unreadable: string[] = [];
  const subjectName = subjectOf(spec);
  for (const [v, view] of TURNTABLE_VIEWS.entries()) {
    const ref = references.find((r) => r.view === view.name);
    if (!ref) {
      unmeasured.push(`${view.name} (the references have no ${view.name} view)`);
      continue;
    }
    // Each render cut to its figure, so the boxes land on the figure at full resolution.
    const renders = plan.seasons.map((s) => figureCrop(afterBySeason[s]![v]!, BACKGROUND));
    const text = await caller.vision(
      LOOKDEV_MARKINGS_OPERATION,
      markingsPrompt({
        subject: subjectName,
        ...(bible.subjects?.[subjectName]?.description !== undefined && {
          description: bible.subjects[subjectName]!.description!,
        }),
        view: view.name,
        referenceRole: ref.role,
        seasons: plan.seasons,
      }),
      [
        ref,
        ...renders.map((r, k) => ({
          ...png(encodePng(r)),
          role: `lit render after look-dev, ${view.name} view, ${plan.seasons[k]}`,
        })),
      ],
    );
    let markings;
    try {
      markings = parseMarkingsReply(text, renders.length + 1);
    } catch {
      unreadable.push(`${view.name} (the markings reply held no JSON)`);
      continue;
    }
    if (markings.length === 0) unmeasured.push(`${view.name} (no marking was named)`);
    const refImage = decodeImage(ref.bytes);
    for (const m of markings) {
      const refBoxes = m.boxes[0];
      const refMark = refBoxes && measureBox(refImage, refBoxes.mark, undefined);
      const refGround = refBoxes && measureBox(refImage, refBoxes.ground, undefined);
      if (!refMark || !refGround) {
        unmeasured.push(`${m.name} in ${view.name} (not located on the reference)`);
        continue;
      }
      renders.forEach((render, k) => {
        const boxes = m.boxes[k + 1];
        const mark = boxes && measureBox(render, boxes.mark, BACKGROUND);
        const ground = boxes && measureBox(render, boxes.ground, BACKGROUND);
        const image = plan.seasons[k]!;
        if (!mark) {
          // The turnaround shows this marking; a render that does not has lost it.
          const missing = boxes ? "not measurable in the render" : "not shown in the render";
          markingMeasures.push({
            marking: m.name,
            view: view.name,
            image,
            drifts: true,
            missing,
            why: missing,
          });
          return;
        }
        markingMeasures.push({
          marking: m.name,
          view: view.name,
          image,
          ...compareMarking(
            { mark: refMark, ground: refGround },
            { mark, ...(ground && { ground }) },
          ),
        });
      });
    }
  }
  reasons.push(markingsReason(markingMeasures, { unmeasured, unreadable }));

  // 6. Identity lock on the looked-dev turntable (front and three-quarter), as for wave 0.
  let identity: IdentityScore | undefined;
  const identityMode = identitySettings(profile);
  const firstSeason = plan.seasons[0]!;
  if (identityMode.mode !== "off") {
    const views = afterBySeason[firstSeason]!;
    const composite = encodePng(sideBySide([views[0]!, views[1]!], turntablePx));
    const subject = subjectOf(spec);
    identity = await scoreIdentity({
      caller,
      record: {
        subject,
        version: bible.version,
        sha256: sha256(
          Buffer.from(
            JSON.stringify({ subject, description: bible.subjects?.[subject]?.description }),
          ),
        ),
        fingerprint: {
          signatureFeatures: [bible.subjects?.[subject]?.description ?? subject],
          proportions: bible.subjects?.[subject]?.description ?? subject,
          palette: bible.palette,
        },
        references: references.map((r) => ({ role: r.role, path: r.path, sha256: r.sha256 })),
      },
      references,
      candidate: {
        role: "candidate turntable",
        path: "(front and three-quarter renders after look-dev)",
        mediaType: "image/png",
        bytes: composite,
        sha256: sha256(composite),
      },
      describe:
        "turntable renders of a 3D character model, front view on the left and three-quarter view on the right",
      settings: identityMode,
    });
    reasons.push(identityReason(identity));
  }

  // 7. Before and after beside the approved turnaround, for the person who approves.
  // Each compare image leads with the turnaround's matching view; one that has to borrow the
  // front view, or has no turnaround column at all, is named in a reason for the person.
  const substituted: string[] = [];
  const noColumn: string[] = [];
  const refFor = (name: string, wanted: string) => {
    let ref = references.find((r) => r.view === wanted);
    if (!ref) {
      ref = references.find((r) => r.view === "front");
      (ref ? substituted : noColumn).push(name);
    }
    return ref ? decodeImage(ref.bytes) : undefined;
  };
  const compareNames = [...TURNTABLE_VIEWS.map((v) => v.name), "close-up"];
  compareNames.forEach((name, i) => {
    const before = i < 4 ? beforeViews[i]! : beforeClose;
    const afters = plan.seasons.map((s) => (i < 4 ? afterBySeason[s]![i]! : afterClose[s]!));
    const ref = refFor(name, name === "close-up" ? "front" : name);
    const height = before.height;
    artifacts.push({
      name: `compare-${name}.png`,
      bytes: encodePng(sideBySide([...(ref ? [ref] : []), before, ...afters], height)),
    });
    artifacts.push({ name: `before-${name}.png`, bytes: encodePng(before) });
    plan.seasons.forEach((s, k) =>
      artifacts.push({ name: `after-${s}-${name}.png`, bytes: encodePng(afters[k]!) }),
    );
  });

  TURNTABLE_VIEWS.forEach((v, i) => {
    artifacts.push({ name: `unlit-before-${v.name}.png`, bytes: encodePng(unlitBefore[i]!) });
    artifacts.push({ name: `unlit-after-${v.name}.png`, bytes: encodePng(unlitAfter[i]!) });
  });

  const views = references.map((r) => r.view).filter((v): v is string => v !== undefined);
  reasons.push({
    check: "lookdev-compare",
    passed: noColumn.length === 0,
    reason:
      substituted.length === 0 && noColumn.length === 0
        ? "every compare image leads with the matching view of the approved references"
        : [
            `the approved references name the view(s) ${views.length > 0 ? [...new Set(views)].join(", ") : "none"}`,
            ...(substituted.length > 0
              ? [`compare-${substituted.join(", compare-")} show(s) the front reference instead`]
              : []),
            ...(noColumn.length > 0
              ? [`compare-${noColumn.join(", compare-")} have no turnaround column`]
              : []),
          ].join("; "),
    source: "deterministic",
  });

  // Stage the candidate.
  const artifactNames: string[] = [];
  for (const a of artifacts) {
    await writeFile(join(runDir, dir, a.name), a.bytes);
    artifactNames.push(join(dir, a.name));
  }
  const stagedSidecars: NonNullable<StagedCandidate["sidecars"]> = [];
  for (const s of sidecars) {
    const file = join(dir, s.name);
    await writeFile(join(runDir, file), s.bytes);
    stagedSidecars.push({
      file,
      name: s.name,
      mediaType: "image/png",
      sha256: sha256(s.bytes),
      field: s.field,
      ...(s.extra && { extra: s.extra }),
    });
  }

  const digitalSourceType: DigitalSourceType =
    provenance.digitalSourceType && provenance.digitalSourceType !== "undeclared"
      ? provenance.digitalSourceType
      : (readDigitalSourceType(options.model.bytes, GLB_MEDIA_TYPE) ??
        DIGITAL_SOURCE_TYPES.generated);
  const bytes = embedDigitalSourceType(raw, GLB_MEDIA_TYPE, digitalSourceType);
  const calls = [...provenance.calls, ...caller.records];
  const outputGrant = grantOf(calls);
  const parameters = {
    ...provenance.parameters,
    targetProfileSha256: profileSha256(profile),
    lookdev: {
      // The file name only: a local path would leak into the target's public provenance.
      sourceModel: basename(options.model.path),
      sourceModelSha256: sourceSha256,
      views: LOOKDEV_VIEWS,
      textureSizePx: textureSize,
      groomSizePx: groomSize,
      seasons: plan.seasons,
      groom: seasonGrooms,
      eyes: markers.eyes.map((m) => ({
        point: m.point.map((v) => round(v)),
        radius: round(m.radius),
      })),
      nose: markers.nose.map((m) => ({
        point: m.point.map((v) => round(v)),
        radius: round(m.radius),
      })),
      padRadiusM: round(padRadius),
      bareTexels: {
        eyes: bareCounts.eyes,
        nose: bareCounts.nose,
        pads: bareCounts["paw pads"],
      },
      closestZoom: look.closestZoom,
      lighting: {
        ambient: lighting.ambient,
        key: lighting.key,
        keyDirection: lighting.keyDirection,
        exposure: round(lighting.exposure, 4),
        auto: look.previewLighting.exposure === "auto",
        litToUnlit,
      },
      furSpeckle,
      markings: markingMeasures.map((m) => ({
        ...m,
        ...(m.deltaE !== undefined && { deltaE: round(m.deltaE, 2) }),
        ...(m.contrastRef !== undefined && { contrastRef: round(m.contrastRef, 2) }),
        ...(m.contrastRender !== undefined && { contrastRender: round(m.contrastRender, 2) }),
      })),
      coverage: round(projection.coverage, 4),
      costUsd: round(budget.spentUsd),
    },
  };
  const step = {
    op: LOOKDEV_STEP,
    params: {
      views: LOOKDEV_VIEWS.length,
      seasons: plan.seasons,
      targetProfileSha256: profileSha256(profile),
    },
    engine: { name: "assetforge-lookdev", version: "1" },
    inputs: [sourceSha256],
    outputs: [sha256(raw)],
  };
  const record: Provenance = {
    ...provenance,
    models: [...new Set([...provenance.models, ...caller.records.map((c) => c.model)])],
    requestIds: [...provenance.requestIds, ...caller.records.map((c) => c.requestId)],
    providerTerms: [
      ...new Set([...provenance.providerTerms, ...caller.records.map((c) => c.providerTerms)]),
    ],
    referenceHashes: [
      ...new Set([...provenance.referenceHashes, ...references.map((r) => r.sha256)]),
    ],
    parameters,
    calls,
    costUsd: round((provenance.costUsd ?? 0) + budget.spentUsd),
    finishedAt: now().toISOString(),
    ...(outputGrant && { outputGrant }),
    ...(identity && { identity }),
    digitalSourceType,
    steps: [...(provenance.steps ?? []), step, metadataStep(digitalSourceType, [])],
  };

  const p = provenance.parameters as Record<string, unknown>;
  const rigParams = p["rig"] as { gaits?: unknown; fit?: { bodyLengthM?: number } } | undefined;
  const bodyLengthM = rigParams?.fit?.bodyLengthM;
  const assetExtras = written.json.asset.extras as Record<string, unknown> | undefined;
  const fields: Record<string, unknown> = {
    triangles: measures.triangles,
    textureMaxPx: measures.textureMaxPx,
    materials: measures.materials,
    bones: measures.bones,
    lods: measures.lods,
    clips: clips(written).map((c) => {
      const extras = (written.json.animations?.[c.index]?.["extras"] ?? {}) as Record<
        string,
        unknown
      >;
      const gait = rig?.gaits[c.name];
      return {
        name: c.name,
        durationMs: Math.round(c.durationS * 1000),
        loop: extras["loop"] === true,
        ...(extras["generated"] === true && { generated: true }),
        ...(extras["generated"] === true &&
          gait &&
          bodyLengthM !== undefined && {
            speedMps: round(gait.speedBodyLengthsPerSecond * bodyLengthM),
          }),
      };
    }),
    ...(p["missingClips"] !== undefined && { missingClips: p["missingClips"] }),
    bounds: { min: framing.min.map((v) => round(v)), max: framing.max.map((v) => round(v)) },
    ...(assetExtras?.["rig"] !== undefined && { rig: assetExtras["rig"] }),
    ...(p["gait"] !== undefined && { gait: p["gait"] }),
    ...(identity && { identity }),
  };

  const passed = qaPassed(reasons);
  const run: RunRecord = {
    runId,
    createdAt: now().toISOString(),
    spec,
    specDir: resolve(options.specDir),
    profile,
    bibleVersion: bible.version,
    capUsd: plan.capUsd,
    estimateUsd: plan.estimateUsd,
    spentUsd: round(budget.spentUsd),
    requested: 1,
    candidates: [],
    filtered: passed ? 0 : 1,
    errors: [],
  };
  if (passed) {
    const file = `${id}.glb`;
    await writeFile(join(runDir, file), bytes);
    run.candidates.push({
      id,
      file,
      mediaType: GLB_MEDIA_TYPE,
      extension: "glb",
      sha256: sha256(bytes),
      reasons,
      fields,
      provenance: record,
      artifacts: artifactNames,
      sidecars: stagedSidecars,
    });
  } else {
    run.rejections = [
      { candidate: 1, reasons, costUsd: round(budget.spentUsd), artifacts: artifactNames },
    ];
  }
  await writeRun(runDir, run);
  return { run, runDir, passed, plan };
}
