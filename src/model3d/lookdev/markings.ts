/**
 * The look-dev markings check (assetgrove#122): each identity marking measured in the lit after
 * renders against the matching turnaround view, in CIELAB, per marking and per view.
 */
import { ProviderError } from "../../errors.ts";
import type { Raster } from "../../image/raster.ts";

/** x0, y0, x1, y1 as fractions 0..1 of the image's width and height. */
export type Box = [number, number, number, number];
export interface MarkingBoxes {
  mark: Box;
  ground: Box;
}
/** One entry in `boxes` per image; null when the image does not show the marking. */
export interface MarkingReply {
  name: string;
  against: string;
  boxes: Array<MarkingBoxes | null>;
}

export const MAX_DELTA_E = 20;
export const MIN_CONTRAST_KEPT = 0.5;
export const MIN_REF_CONTRAST = 8;

const BACKGROUND_TOLERANCE = 24;
const MIN_PIXELS = 12;

export function markingsPrompt(options: {
  subject: string;
  description?: string;
  view: string;
  referenceRole: string;
  seasons: string[];
}): string {
  const { subject, description, view, referenceRole, seasons } = options;
  const coats =
    seasons.length === 1 && seasons[0] === "default"
      ? "one lit render"
      : `one lit render per coat, in this order: ${seasons.join(", ")}`;
  const lines = [
    "You compare identity markings between an approved reference and renders of a 3D model.",
    description ? `Subject: ${subject}, ${description}.` : `Subject: ${subject}.`,
    `Image 1 is the approved reference (${referenceRole}). Images 2 onward are lit renders of the character's 3D model in the ${view} view, ${coats}, each cut to the figure.`,
    "List every identity marking that the subject description names or the reference shows: distinct coloured patches, masks, rims, bands, rings, stripes, spots.",
    'For each marking, give in every image the tight box of the marking and a box of the neighbouring region it contrasts with ("against" names that region). Boxes are [ymin, xmin, ymax, xmax], integers from 0 to 1000 down the image height (y) and across its width (x), origin top left. Use null for an image that does not show the marking.',
    'Reply with JSON only: {"markings":[{"name": string, "against": string, "boxes": [{"mark":[ymin,xmin,ymax,xmax],"ground":[ymin,xmin,ymax,xmax]} | null, ...]}]}',
    "The boxes array has one entry per image, in image order, reference first.",
  ];
  return lines.join("\n");
}

function firstObject(text: string): unknown {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

/** The reply's box scale: integers 0..1000 of the image's height and width. */
export const BOX_SCALE = 1000;

/**
 * A reply box, `[y0, x0, y1, x1]` on the 0..1000 scale (the order vision models most often box
 * in), as an `[x0, y0, x1, y1]` fraction box. A box that mixes fractions under 1 with values
 * above 1 mixes two scales, so it is dropped rather than guessed at.
 */
function parseBox(value: unknown): Box | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const n = value.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN));
  if (n.some(Number.isNaN)) return undefined;
  if (n.some((v) => v! > 1) && n.some((v) => v! > 0 && v! < 1)) return undefined;
  const c = [n[1]!, n[0]!, n[3]!, n[2]!].map((v) => Math.min(1, Math.max(0, v / BOX_SCALE)));
  const x0 = Math.min(c[0]!, c[2]!);
  const x1 = Math.max(c[0]!, c[2]!);
  const y0 = Math.min(c[1]!, c[3]!);
  const y1 = Math.max(c[1]!, c[3]!);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return undefined;
  return [x0, y0, x1, y1];
}

function parseBoxes(value: unknown): MarkingBoxes | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const mark = parseBox(v.mark);
  const ground = parseBox(v.ground);
  return mark && ground ? { mark, ground } : null;
}

export function parseMarkingsReply(text: string, images: number): MarkingReply[] {
  const parsed = firstObject(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new ProviderError("the markings reply contained no JSON object");
  }
  const list = (parsed as { markings?: unknown }).markings;
  if (!Array.isArray(list)) return [];
  const out: MarkingReply[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    if (typeof m.name !== "string" || m.name.trim() === "" || !Array.isArray(m.boxes)) continue;
    const boxes: Array<MarkingBoxes | null> = [];
    for (let i = 0; i < images; i++) boxes.push(parseBoxes(m.boxes[i]));
    out.push({
      name: m.name.trim(),
      against: typeof m.against === "string" ? m.against.trim() : "",
      boxes,
    });
  }
  return out;
}

function linear(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function toLab(r: number, g: number, b: number): [number, number, number] {
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export interface Patch {
  lab: [number, number, number];
  /** The spread of L* inside the box, 80th minus 20th percentile: the banding of a ringed mark. */
  spread: number;
  pixels: number;
}

function quantile(sorted: number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function borderColour(image: Raster): [number, number, number] {
  const ch: number[][] = [[], [], []];
  const take = (x: number, y: number) => {
    const i = (y * image.width + x) * 4;
    for (let c = 0; c < 3; c++) ch[c]!.push(image.data[i + c]!);
  };
  for (let x = 0; x < image.width; x++) {
    take(x, 0);
    take(x, image.height - 1);
  }
  for (let y = 1; y < image.height - 1; y++) {
    take(0, y);
    take(image.width - 1, y);
  }
  return [median(ch[0]!), median(ch[1]!), median(ch[2]!)];
}

export function measureBox(
  image: Raster,
  box: Box,
  background: [number, number, number] | undefined,
): Patch | undefined {
  if (image.width === 0 || image.height === 0) return undefined;
  const bg = background ?? borderColour(image);
  const x0 = Math.max(0, Math.floor(box[0] * image.width));
  const x1 = Math.min(image.width, Math.ceil(box[2] * image.width));
  const y0 = Math.max(0, Math.floor(box[1] * image.height));
  const y1 = Math.min(image.height, Math.ceil(box[3] * image.height));
  const ch: number[][] = [[], [], []];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      const r = image.data[i]!;
      const g = image.data[i + 1]!;
      const b = image.data[i + 2]!;
      if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) <= BACKGROUND_TOLERANCE) {
        continue;
      }
      const lab = toLab(r, g, b);
      for (let c = 0; c < 3; c++) ch[c]!.push(lab[c]!);
    }
  }
  const pixels = ch[0]!.length;
  if (pixels < MIN_PIXELS) return undefined;
  const lightness = [...ch[0]!].sort((a, b) => a - b);
  return {
    lab: [median(ch[0]!), median(ch[1]!), median(ch[2]!)],
    spread: quantile(lightness, 0.8) - quantile(lightness, 0.2),
    pixels,
  };
}

/**
 * How a marking's contrast is measured: `against` the neighbouring coat (mark L* minus ground
 * L*), `within` the mark's own box (its L* spread, for a banded or ringed mark whose median
 * matches its neighbour's), or `none` when the turnaround shows too little of either to measure.
 */
export type ContrastKind = "against" | "within" | "none";

export interface MarkingComparison {
  deltaE: number;
  contrastKind: ContrastKind;
  contrastRef: number;
  contrastRender: number;
  drifts: boolean;
  why?: string;
}

export interface MarkingMeasure extends Partial<MarkingComparison> {
  marking: string;
  view: string;
  image: string;
  drifts: boolean;
  /** Set when the turnaround shows the marking and the render does not: it drifts. */
  missing?: string;
  why?: string;
}

const round1 = (n: number): string => {
  const r = Math.round(n * 10) / 10;
  return (Object.is(r, -0) ? 0 : r).toFixed(1);
};

export function compareMarking(
  ref: { mark: Patch; ground: Patch },
  render: { mark: Patch; ground?: Patch },
): MarkingComparison {
  const a = ref.mark.lab;
  const b = render.mark.lab;
  const deltaE = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const against = a[0] - ref.ground.lab[0];
  // A render whose neighbouring-coat box holds no figure leaves only the colour and banding.
  const contrastKind: ContrastKind =
    Math.abs(against) >= MIN_REF_CONTRAST && render.ground
      ? "against"
      : ref.mark.spread >= MIN_REF_CONTRAST
        ? "within"
        : "none";
  const contrastRef = contrastKind === "within" ? ref.mark.spread : against;
  const contrastRender =
    contrastKind === "against" ? b[0] - render.ground!.lab[0] : render.mark.spread;
  const base = { deltaE, contrastKind, contrastRef, contrastRender };
  if (deltaE > MAX_DELTA_E) {
    return { ...base, drifts: true, why: `colour ΔE ${round1(deltaE)}` };
  }
  if (
    contrastKind === "against" &&
    (Math.sign(contrastRender) !== Math.sign(contrastRef) ||
      Math.abs(contrastRender) < MIN_CONTRAST_KEPT * Math.abs(contrastRef))
  ) {
    return {
      ...base,
      drifts: true,
      why: `contrast ${round1(contrastRef)} → ${round1(contrastRender)} L*`,
    };
  }
  if (contrastKind === "within" && contrastRender < MIN_CONTRAST_KEPT * contrastRef) {
    return {
      ...base,
      drifts: true,
      why: `banding ${round1(contrastRef)} → ${round1(contrastRender)} L*`,
    };
  }
  return { ...base, drifts: false };
}

function detail(m: MarkingMeasure): string {
  if (m.missing !== undefined) return `${m.image} ${m.missing}`;
  const contrast =
    m.contrastKind === "within"
      ? `banding ${round1(m.contrastRef!)}→${round1(m.contrastRender!)} L*`
      : m.contrastKind === "none"
        ? `contrast not measurable (turnaround ${round1(m.contrastRef!)} L*)`
        : `contrast ${round1(m.contrastRef!)}→${round1(m.contrastRender!)} L*`;
  return `${m.image} ΔE ${round1(m.deltaE!)}, ${contrast}`;
}

/**
 * Why the check is advisory, said in every reason: its boxes come from a vision model, and on
 * unchanged code they name a different set of drifting markings on each run (docs/decisions.md).
 */
export const MARKINGS_ADVISORY =
  "advisory, never filters: the boxes come from a vision model, and on the same code they name a different set of drifting markings on each run, so a person judges the compare images";

/**
 * The check's verdict. A marking drifts when its colour or contrast drifts, or when the
 * turnaround shows it and a render does not (`missing`); a view whose reply could not be read
 * (`unreadable`) fails too, because a marking there could have vanished unseen. Only what the
 * references give nothing to measure (`unmeasured`) passes, named. The verdict is recorded with
 * every measurement but is `shadow`: it never filters the candidate (MARKINGS_ADVISORY).
 */
export function markingsReason(
  measures: MarkingMeasure[],
  notes: { unmeasured: string[]; unreadable?: string[] },
): {
  check: "lookdev-markings";
  passed: boolean;
  reason: string;
  source: "deterministic";
  shadow: true;
} {
  const parts: string[] = [MARKINGS_ADVISORY];
  if (measures.length === 0) {
    parts.push("no marking was measured");
  } else {
    const views = [...new Set(measures.map((m) => m.view))];
    const clauses = views.map((view) => {
      const inView = measures.filter((m) => m.view === view);
      const names = [...new Set(inView.map((m) => m.marking))];
      const each = names.map((name) => {
        const measured = inView
          .filter((m) => m.marking === name)
          .map(detail)
          .join("; ");
        return `${name} (${measured})`;
      });
      return `${view}: ${each.join("; ")}`;
    });
    parts.push(`measured ${clauses.join(" | ")}`);
    const drifting = measures.filter((m) => m.drifts);
    if (drifting.length > 0) {
      parts.push(
        `drifting: ${drifting.map((m) => `${m.marking} (${m.view}, ${m.image}: ${m.why ?? "drift"})`).join(", ")}`,
      );
    }
  }
  const unreadable = notes.unreadable ?? [];
  if (unreadable.length > 0) parts.push(`unreadable: ${unreadable.join("; ")}`);
  if (notes.unmeasured.length > 0) parts.push(`not measured: ${notes.unmeasured.join("; ")}`);
  return {
    check: "lookdev-markings",
    passed: !measures.some((m) => m.drifts) && unreadable.length === 0,
    reason: parts.join(". "),
    source: "deterministic",
    shadow: true,
  };
}
