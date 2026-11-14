import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRaster, decodeImage, encodePng, parseHex, setPixel } from "./image/raster.ts";
import { InputError } from "./errors.ts";
import type {
  AssetSpec,
  BibleLook,
  LoadedReference,
  Size,
  StyleBible,
  TargetProfile,
} from "./types.ts";

/**
 * Request building: model inputs come from the asset spec and the style bible, never from freehand
 * text. References (subject images, the perspective sample and a palette swatch) go as images.
 */

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Media type from the file's own signature, so no list of formats or extensions is kept. */
export function sniffMediaType(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head.subarray(0, 4).toString("latin1") === "RIFF") {
    return head.subarray(8, 12).toString("latin1") === "WEBP" ? "image/webp" : "audio/wav";
  }
  return "application/octet-stream";
}

/** The first line of a Git LFS pointer file (Git LFS spec v1), which stands in for an unfetched object. */
const LFS_POINTER_HEADER = "version https://git-lfs.github.com/spec/v1\n";
/** The Git LFS spec caps pointer files below this size. */
const LFS_POINTER_MAX_BYTES = 1024;

/** Whether the bytes are a Git LFS pointer file rather than the object it points to. */
export function isLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.length >= LFS_POINTER_MAX_BYTES) return false;
  const head = Buffer.from(bytes.subarray(0, LFS_POINTER_HEADER.length)).toString("latin1");
  return head === LFS_POINTER_HEADER;
}

/** A WebP whose RIFF container holds its declared length and starts with an image chunk. */
function wellFormedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 20) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = view.subarray(12, 16).toString("latin1");
  return view.readUInt32LE(4) + 8 <= bytes.length && ["VP8 ", "VP8L", "VP8X"].includes(chunk);
}

/**
 * Why the bytes are not a usable reference image, or undefined when they are one: the signature
 * must name an image type and the image must decode (WebP, which Assetgrove does not decode, must
 * have a well-formed container).
 */
export function referenceImageProblem(bytes: Uint8Array): string | undefined {
  if (isLfsPointer(bytes)) {
    return "is a Git LFS pointer, not the image: fetch the LFS objects with `git lfs pull` and run again";
  }
  const mediaType = sniffMediaType(bytes);
  if (!mediaType.startsWith("image/")) return "is not an image of a known type";
  if (mediaType === "image/webp") {
    return wellFormedWebp(bytes) ? undefined : "is not a decodable image/webp";
  }
  try {
    decodeImage(bytes);
  } catch (error) {
    return `is not a decodable ${mediaType}: ${(error as Error).message}`;
  }
  return undefined;
}

/**
 * Loads a reference image for a model call. Every reference reaches the model through here, so a
 * file that is not a decodable image (such as a Git LFS pointer) is refused as invalid input
 * before anything is spent.
 */
export async function loadReference(
  path: string,
  role: string,
  baseDir: string,
): Promise<LoadedReference> {
  const full = resolve(baseDir, path);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(full));
  } catch (error) {
    throw new InputError(`cannot read the ${role} image ${full}`, { cause: error });
  }
  const problem = referenceImageProblem(bytes);
  if (problem) throw new InputError(`the ${role} image ${full} ${problem}`);
  return { role, path, mediaType: sniffMediaType(bytes), bytes, sha256: sha256(bytes) };
}

/** A swatch image of the palette: one 16 px square per colour, in bible order. */
export function paletteSwatch(palette: string[]): LoadedReference {
  const cell = 16;
  const raster = createRaster(cell * Math.max(palette.length, 1), cell);
  palette.forEach((hex, i) => {
    const [r, g, b] = parseHex(hex);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) setPixel(raster, i * cell + x, y, [r, g, b, 255]);
    }
  });
  const bytes = encodePng(raster);
  return {
    role: "palette",
    path: "(palette swatch)",
    mediaType: "image/png",
    bytes,
    sha256: sha256(bytes),
  };
}

export interface BibleInputs {
  /** References of the spec's subject (character sheets, turnarounds, props). */
  subject: LoadedReference[];
  perspective: LoadedReference;
  palette: LoadedReference;
}

export function subjectOf(spec: AssetSpec): string {
  return spec.subject ?? spec.assetId;
}

export async function loadBibleInputs(
  spec: AssetSpec,
  bible: StyleBible,
  bibleDir: string,
): Promise<BibleInputs> {
  const subject = subjectOf(spec);
  lookOf(spec, bible);
  const refs = bible.references.filter(
    (r) =>
      r.subject === subject &&
      r.role !== "perspective" &&
      (r.look === undefined || r.look === spec.look),
  );
  if (refs.length === 0) {
    throw new InputError(`the style bible has no reference images for subject "${subject}"`);
  }
  return {
    subject: await Promise.all(refs.map((r) => loadReference(r.path, r.role, bibleDir))),
    perspective: await loadReference(bible.perspective, "perspective", bibleDir),
    palette: paletteSwatch(bible.palette),
  };
}

export interface FrameGrid {
  frame: Size;
  count: number;
  durationMs?: number;
}

export function frameGrid(
  spec: AssetSpec,
  profile: TargetProfile,
  defaultCount: number,
): FrameGrid {
  const frame = {
    width: spec.frames?.width ?? profile.frames.width,
    height: spec.frames?.height ?? profile.frames.height,
  };
  const count = spec.frames?.count ?? defaultCount;
  const max = profile.frames.maxEdge;
  if (max !== undefined && (frame.width > max || frame.height > max)) {
    throw new InputError(
      `frame ${frame.width}x${frame.height} exceeds the profile's ${max} px frame edge`,
    );
  }
  if (!Number.isInteger(count) || count < 1) throw new InputError(`invalid frame count: ${count}`);
  const durationMs = spec.frames?.durationMs ?? profile.frames.durationMs;
  return durationMs === undefined ? { frame, count } : { frame, count, durationMs };
}

function lookOf(spec: AssetSpec, bible: StyleBible): BibleLook | undefined {
  if (spec.look === undefined) return undefined;
  const look = bible.looks?.[spec.look];
  if (!look) throw new InputError(`the style bible declares no look "${spec.look}"`);
  return look;
}

/** The bible's shared style notes, then the notes of the spec's look, if it has one. */
export function styleNotes(spec: AssetSpec, bible: StyleBible): string[] {
  return [...(bible.notes ?? []), ...(lookOf(spec, bible)?.notes ?? [])];
}

function styleLines(spec: AssetSpec, bible: StyleBible): string[] {
  const lines = [`Palette, use only these colours: ${bible.palette.join(", ")}.`];
  if (bible.mood?.length) lines.push(`Mood: ${bible.mood.join(", ")}.`);
  for (const note of styleNotes(spec, bible)) lines.push(`Style note: ${note}`);
  return lines;
}

function subjectLine(spec: AssetSpec, bible: StyleBible): string {
  const subject = subjectOf(spec);
  const description = bible.subjects?.[subject]?.description;
  return description ? `Subject: ${subject}, ${description}.` : `Subject: ${subject}.`;
}

/** The key pose (or a still): a text-and-reference generation. */
export function buildStillPrompt(
  spec: AssetSpec,
  bible: StyleBible,
  grid: FrameGrid,
  refs: BibleInputs,
): string {
  const pose = spec.animationFamily
    ? `Key pose for the "${spec.animationFamily}" animation.`
    : "A still sprite.";
  return [
    `Game sprite for the style bible version ${bible.version}.`,
    subjectLine(spec, bible),
    pose,
    `It will be scaled to a ${grid.frame.width}x${grid.frame.height} px frame, so keep the silhouette readable.`,
    `Reference images, in order: ${[...refs.subject.map((r) => r.role), "perspective sample", "palette swatch"].join(", ")}. Match the subject's identity to the subject references and the camera angle to the perspective sample.`,
    ...styleLines(spec, bible),
  ].join("\n");
}

/** One animation frame: a reference-guided edit of the key pose. */
export function buildFramePrompt(
  spec: AssetSpec,
  bible: StyleBible,
  grid: FrameGrid,
  index: number,
): string {
  return [
    `Edit this key pose into frame ${index + 1} of ${grid.count} of the "${spec.animationFamily ?? "animation"}" animation loop.`,
    subjectLine(spec, bible),
    "Keep the same character, proportions, colours, camera angle, scale and background; change only the pose for this point in the motion.",
    ...styleLines(spec, bible),
  ].join("\n");
}
