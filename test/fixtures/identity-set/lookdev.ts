/**
 * The 3D cases of #82's look-dev (Outcome 9): Stevie's looked-dev turntable renders, committed under
 * `docs/examples/look-dev/stevie/` by the real look-dev run, each a 3D positive for Stevie, and pixel
 * drift of some of them made in code as 3D drift. They join the Raccoon World cast. No other cast
 * member has a 3D model yet, so there are no 3D look-alikes. The 3D generics are a second real
 * look-dev run on Stevie's mesh with a generic subject in place of Stevie: the bible's subject was
 * "an ordinary raccoon with a pale, silvery coat and a narrow eye mask, not any particular named
 * character", and its one reference the set's 2D generic `generic-silver-front`. They are committed
 * under `docs/examples/look-dev/generic/`, and each is a negative against every cast member, as the
 * 2D generics are. They keep Stevie's mesh and proportions; only the surface is generic.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeImage, encodePng } from "../../../src/image/raster.ts";
import { applyDrift, type DriftEdit } from "./raccoon-world.ts";

export const LOOKDEV_DIR = new URL("../../../docs/examples/look-dev/stevie/", import.meta.url);
export const LOOKDEV_SUBJECT = "stevie";
export const LOOKDEV_SEASONS = ["summer", "winter"] as const;
export const LOOKDEV_VIEWS = ["front", "three-quarter", "side", "back", "close-up"] as const;
export const LOOKDEV_GENERIC_DIR = new URL(
  "../../../docs/examples/look-dev/generic/",
  import.meta.url,
);
/** The cast a generic is a negative against, as for the 2D generics (generated.json `subjects`). */
export const LOOKDEV_GENERIC_SUBJECTS = ["jimothy", "stevie"] as const;

/** Pixel drift of looked-dev renders: the two wave-0 3D drift edits, plus a colourless coat. */
export const LOOKDEV_DRIFT: { from: string; edit: DriftEdit; amount: number; note: string }[] = [
  {
    from: "after-summer-front",
    edit: "hue-shift",
    amount: 150,
    note: "looked-dev render with wrong colours",
  },
  {
    from: "after-summer-side",
    edit: "stretch-tall",
    amount: 1.6,
    note: "looked-dev render with lean, tall proportions",
  },
  {
    from: "after-winter-three-quarter",
    edit: "desaturate",
    amount: 1,
    note: "looked-dev render with the coat colour removed",
  },
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The looked-dev cases, with images copied (or drifted) into `<raccoonWorldDir>/lookdev/`. A
 * checkout without its Git LFS media (CI's) holds pointer files; those renders, and drift made from
 * them, are left out with a note on stderr.
 */
export async function lookdevCases(
  raccoonWorldDir: string,
  bible: string,
  options: { sourceDir?: URL; genericDir?: URL; cast?: string } = {},
) {
  const sourceDir = options.sourceDir ?? LOOKDEV_DIR;
  const genericDir = options.genericDir ?? LOOKDEV_GENERIC_DIR;
  const cast = options.cast ?? "raccoon-world";
  await mkdir(join(raccoonWorldDir, "lookdev"), { recursive: true });
  const cases: { image: string; bible: string; [key: string]: unknown }[] = [];
  const present = new Map<string, Buffer>();
  const missing: string[] = [];
  for (const season of LOOKDEV_SEASONS)
    for (const view of LOOKDEV_VIEWS) {
      const name = `after-${season}-${view}`;
      const bytes = await readFile(new URL(`${name}.png`, sourceDir)).catch(() => undefined);
      if (!bytes || !PNG_SIGNATURE.equals(bytes.subarray(0, 8))) {
        missing.push(name);
        continue;
      }
      present.set(name, bytes);
      const image = `lookdev/${LOOKDEV_SUBJECT}-${name}.png`;
      await copyFile(new URL(`${name}.png`, sourceDir), join(raccoonWorldDir, image));
      cases.push({
        image,
        subject: LOOKDEV_SUBJECT,
        same: true,
        kind: "same",
        cast,
        medium: "3d",
        bible,
        note: `Stevie after look-dev (#82), ${season} coat, ${view} turntable render`,
      });
    }
  for (const d of LOOKDEV_DRIFT) {
    const bytes = present.get(d.from);
    if (!bytes) continue;
    const image = `lookdev/${LOOKDEV_SUBJECT}-${d.from}-${d.edit}.png`;
    await writeFile(
      join(raccoonWorldDir, image),
      encodePng(applyDrift(decodeImage(bytes), d.edit, d.amount)),
    );
    cases.push({
      image,
      subject: LOOKDEV_SUBJECT,
      same: false,
      kind: "drift",
      cast,
      medium: "3d",
      bible,
      note: `${d.edit} ${d.amount} of ${d.from}: ${d.note}`,
    });
  }
  for (const view of LOOKDEV_VIEWS) {
    const name = `after-summer-${view}`;
    const bytes = await readFile(new URL(`${name}.png`, genericDir)).catch(() => undefined);
    if (!bytes || !PNG_SIGNATURE.equals(bytes.subarray(0, 8))) {
      missing.push(`generic ${name}`);
      continue;
    }
    const image = `lookdev/generic-${name}.png`;
    await writeFile(join(raccoonWorldDir, image), bytes);
    for (const subject of LOOKDEV_GENERIC_SUBJECTS)
      cases.push({
        image,
        subject,
        same: false,
        kind: "generic",
        cast,
        medium: "3d",
        bible,
        note: `generic raccoon surface on Stevie's mesh, looked-dev (#82) summer coat, ${view} turntable render`,
      });
  }
  if (missing.length > 0)
    console.error(
      `${missing.length} looked-dev renders are not in this checkout (Git LFS media not fetched); left out`,
    );
  return cases;
}
