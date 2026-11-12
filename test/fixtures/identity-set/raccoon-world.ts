import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { BIBLE_PRESETS, serializeBible } from "../../../src/bible.ts";
import type { IdentityLock } from "../../../src/bible.ts";
import { createRaster, decodeImage, encodePng } from "../../../src/image/raster.ts";
import type { Raster } from "../../../src/image/raster.ts";

export interface EvalCaseJson {
  image: string;
  subject: string;
  same: boolean;
  kind?: "same" | "lookalike" | "generic" | "drift";
  cast: string;
  medium?: "2d" | "3d";
  bible?: string;
  describe?: string;
  note?: string;
}

export interface RaccoonWorldManifest {
  repository: string;
  commit: string;
  bible: { world: string; preset: string; identities: Record<string, IdentityLock> };
  conflict: {
    subject: string;
    version: string;
    note: string;
    signatureFeatures: string[];
    proportions: string;
    positives: string[];
    negatives: string[];
  };
  images: {
    path: string;
    subject: string;
    same: boolean;
    kind: "same" | "lookalike" | "generic";
    medium: "2d" | "3d";
    note: string;
  }[];
  drift: {
    from: string;
    subject: string;
    edit: DriftEdit;
    amount: number;
    medium: "2d" | "3d";
    note: string;
  }[];
}
export type DriftEdit = "hue-shift" | "desaturate" | "stretch-wide" | "stretch-tall";

const BIBLE_DIR = "art";
const PROSE = "# Raccoon World\n\n## Do's and Don'ts\nDo keep each identity lock.\n";

async function loadManifest(): Promise<RaccoonWorldManifest> {
  const url = new URL("./raccoon-world.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as RaccoonWorldManifest;
}

/** Rotates hue by `degrees` and returns the new RGB. */
function rotateHue(r: number, g: number, b: number, degrees: number): [number, number, number] {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const c = max - min;
  if (c === 0) return [r, g, b];
  const s = c / (1 - Math.abs(2 * l - 1));
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  let h: number;
  if (max === rn) h = ((gn - bn) / c + 6) % 6;
  else if (max === gn) h = (bn - rn) / c + 2;
  else h = (rn - gn) / c + 4;
  h = (h * 60 + degrees + 360) % 360;
  const k = (n: number) => (n + h / 30) % 12;
  const f = (n: number) =>
    Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)];
}

function mapColour(src: Raster, fn: (r: number, g: number, b: number) => number[]): Raster {
  const out = createRaster(src.width, src.height);
  for (let i = 0; i < src.data.length; i += 4) {
    const [r, g, b] = fn(src.data[i]!, src.data[i + 1]!, src.data[i + 2]!);
    out.data[i] = r!;
    out.data[i + 1] = g!;
    out.data[i + 2] = b!;
    out.data[i + 3] = src.data[i + 3]!;
  }
  return out;
}

/** Bilinear stretch of each axis independently (a wider or taller canvas, the figure distorted). */
function stretch(src: Raster, fx: number, fy: number): Raster {
  const out = createRaster(Math.round(src.width * fx), Math.round(src.height * fy));
  const at = (x: number, y: number, c: number) =>
    src.data[(Math.min(src.height - 1, y) * src.width + Math.min(src.width - 1, x)) * 4 + c]!;
  for (let y = 0; y < out.height; y++) {
    const v = Math.max(0, (y + 0.5) / fy - 0.5);
    const y0 = Math.floor(v);
    for (let x = 0; x < out.width; x++) {
      const u = Math.max(0, (x + 0.5) / fx - 0.5);
      const x0 = Math.floor(u);
      for (let c = 0; c < 4; c++) {
        const top = at(x0, y0, c) * (1 - (u - x0)) + at(x0 + 1, y0, c) * (u - x0);
        const bottom = at(x0, y0 + 1, c) * (1 - (u - x0)) + at(x0 + 1, y0 + 1, c) * (u - x0);
        out.data[(y * out.width + x) * 4 + c] = Math.round(
          top * (1 - (v - y0)) + bottom * (v - y0),
        );
      }
    }
  }
  return out;
}

export function applyDrift(src: Raster, edit: DriftEdit, amount: number): Raster {
  switch (edit) {
    case "hue-shift":
      return mapColour(src, (r, g, b) => rotateHue(r, g, b, amount));
    case "desaturate":
      return mapColour(src, (r, g, b) => {
        const grey = 0.299 * r + 0.587 * g + 0.114 * b;
        return [r, g, b].map((v) => Math.round(v + (grey - v) * amount));
      });
    case "stretch-wide":
      return stretch(src, amount, 1);
    case "stretch-tall":
      return stretch(src, 1, amount);
  }
}

async function download(
  fetchImpl: typeof fetch,
  manifest: RaccoonWorldManifest,
  outDir: string,
  path: string,
): Promise<void> {
  const target = join(outDir, path);
  const existing = await stat(target).catch(() => undefined);
  if (existing && existing.size > 0) return;
  const url = `https://media.githubusercontent.com/media/${manifest.repository}/${manifest.commit}/${path}`;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, new Uint8Array(await response.arrayBuffer()));
}

/** A lock's reference paths are relative to the bible; the repository path drops the leading `../`. */
const repoPath = (ref: string) => posix.normalize(posix.join(BIBLE_DIR, ref));

function bibleSource(manifest: RaccoonWorldManifest, identities: Record<string, IdentityLock>) {
  const data = structuredClone(BIBLE_PRESETS[manifest.bible.preset]!);
  data.world = manifest.bible.world;
  data.identities = identities;
  return serializeBible(data, PROSE);
}

export async function buildRaccoonWorldSet(
  outDir: string,
  options: { fetch?: typeof fetch; manifest?: RaccoonWorldManifest } = {},
): Promise<{ biblePath: string; conflictBiblePath: string; cases: EvalCaseJson[] }> {
  const manifest = options.manifest ?? (await loadManifest());
  const fetchImpl = options.fetch ?? fetch;
  const paths = new Set<string>([
    ...manifest.images.map((i) => i.path),
    ...manifest.drift.map((d) => d.from),
    ...manifest.conflict.positives,
    ...manifest.conflict.negatives,
    ...Object.values(manifest.bible.identities).flatMap((lock) =>
      [lock.turnaround, ...(lock.references ?? [])].map(repoPath),
    ),
  ]);
  await Promise.all([...paths].map((path) => download(fetchImpl, manifest, outDir, path)));

  const biblePath = join(outDir, BIBLE_DIR, "BIBLE.md");
  const conflictBiblePath = join(outDir, BIBLE_DIR, "BIBLE-conflict.md");
  await mkdir(dirname(biblePath), { recursive: true });
  await writeFile(biblePath, bibleSource(manifest, manifest.bible.identities));
  const { subject, version, signatureFeatures, proportions } = manifest.conflict;
  const record = manifest.bible.identities[subject]!;
  await writeFile(
    conflictBiblePath,
    bibleSource(manifest, {
      ...manifest.bible.identities,
      [subject]: { ...record, version, signatureFeatures, proportions },
    }),
  );

  const cast = "raccoon-world";
  const bible = posix.join(BIBLE_DIR, "BIBLE.md");
  const cases: EvalCaseJson[] = manifest.images.map((i) => ({
    image: i.path,
    subject: i.subject,
    same: i.same,
    kind: i.kind,
    cast,
    medium: i.medium,
    bible,
    note: i.note,
  }));
  for (const [index, d] of manifest.drift.entries()) {
    const name = posix.basename(d.from, ".png");
    const image = `drift/${index}-${d.subject}-${name}-${d.edit}.png`;
    const source = decodeImage(await readFile(join(outDir, d.from)));
    await mkdir(join(outDir, "drift"), { recursive: true });
    await writeFile(join(outDir, image), encodePng(applyDrift(source, d.edit, d.amount)));
    cases.push({
      image,
      subject: d.subject,
      same: false,
      kind: "drift",
      cast,
      medium: d.medium,
      bible,
      note: `${d.edit} ${d.amount} of ${d.from}: ${d.note}`,
    });
  }
  const conflictBible = posix.join(BIBLE_DIR, "BIBLE-conflict.md");
  for (const [paths, same] of [
    [manifest.conflict.positives, true],
    [manifest.conflict.negatives, false],
  ] as const)
    for (const image of paths)
      cases.push({
        image,
        subject,
        same,
        kind: same ? "same" : "lookalike",
        cast: "raccoon-world-conflict",
        medium: "2d",
        bible: conflictBible,
        note: `judged against the v1 text record: ${manifest.conflict.note}`,
      });
  return { biblePath, conflictBiblePath, cases };
}
