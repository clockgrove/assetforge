/**
 * Builds #92's identity acceptance set: the synthetic bird cast (drawn in code) and the Raccoon
 * World cast (downloaded from clockgrove/raccoon-world's public references at the pinned commit,
 * plus the generated generics and drift committed under `generated/`, see generate.ts), with one
 * cases file for `assetforge identity-eval --cases <out>/cases.json`. Nothing it writes
 * belongs in the repository.
 *
 *   node test/fixtures/identity-set/build.ts <out-dir> [--no-raccoon-world]
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { buildBirdCastSet } from "./birds.ts";
import { GENERATED_DIR, loadGeneratedManifest } from "./generate.ts";
import { buildRaccoonWorldSet } from "./raccoon-world.ts";

interface PathCase {
  image: string;
  bible?: string;
}

/**
 * The committed generated images as cases in the Raccoon World set: a generic is a negative
 * against every cast member, a drift image a negative against its own subject, and a sheet frame
 * checked on-model a positive for its subject and a look-alike for every other member. A frame of an
 * animation (or drift made from one) is described as a frame of that family. Images are copied
 * to `<raccoonWorldDir>/generated/`, beside the set's bible. A checkout without its Git LFS media
 * (CI's) holds pointer files; those items are left out with a note on stderr.
 */
export async function generatedCases(raccoonWorldDir: string, bible: string) {
  const manifest = await loadGeneratedManifest();
  await mkdir(join(raccoonWorldDir, "generated"), { recursive: true });
  const cases: (PathCase & Record<string, unknown>)[] = [];
  const missing: string[] = [];
  for (const item of manifest.items) {
    const source = new URL(`${item.id}.png`, GENERATED_DIR);
    const head = await readFile(source).catch(() => undefined);
    if (!head || !PNG_SIGNATURE.equals(head.subarray(0, 8))) {
      missing.push(item.id);
      continue;
    }
    const image = `generated/${item.id}.png`;
    await copyFile(source, join(raccoonWorldDir, image));
    const subjects = item.kind === "drift" ? [item.subject!] : manifest.subjects;
    const note =
      item.kind === "generic"
        ? `generated on-style generic (${item.route} route, no reference): ${item.what}`
        : item.kind === "same"
          ? `generated ${item.subject} frame (${item.route} route): ${item.what} (checked ${item.checked})`
          : `generated drift of ${item.from} (${item.route} route): ${item.drift}`;
    for (const subject of subjects) {
      const same = item.kind === "same" && subject === item.subject;
      cases.push({
        image,
        subject,
        same,
        kind: item.kind === "same" ? (same ? "same" : "lookalike") : item.kind,
        cast: manifest.cast,
        medium: "2d",
        bible,
        note,
        // A frame of an animation is described as one, as a run describes its candidate.
        ...(item.family !== undefined && {
          describe: `a frame of one character's "${item.family}" animation`,
        }),
        ...(item.heldOut !== undefined && { heldOut: item.heldOut }),
      });
    }
  }
  if (missing.length > 0)
    console.error(
      `${missing.length} generated images are not in this checkout (Git LFS media not fetched); left out`,
    );
  return cases;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Both casts under `outDir`, and one cases file whose paths are relative to it. */
export async function buildIdentitySet(
  outDir: string,
  options: { raccoonWorld?: boolean; fetch?: typeof fetch } = {},
): Promise<{ casesPath: string; cases: unknown[] }> {
  const cases: unknown[] = [];
  const add = (dir: string, list: PathCase[]) => {
    for (const c of list)
      cases.push({
        ...c,
        image: `${dir}/${c.image}`,
        ...(c.bible !== undefined && { bible: `${dir}/${c.bible}` }),
      });
  };
  await mkdir(outDir, { recursive: true });
  add("birds", (await buildBirdCastSet(join(outDir, "birds"))).cases);
  if (options.raccoonWorld !== false) {
    const dir = join(outDir, "raccoon-world");
    const set = await buildRaccoonWorldSet(
      dir,
      options.fetch ? { fetch: options.fetch } : undefined,
    );
    add("raccoon-world", set.cases);
    add("raccoon-world", await generatedCases(dir, relative(dir, set.biblePath)));
  }
  const casesPath = join(outDir, "cases.json");
  await writeFile(casesPath, `${JSON.stringify(cases, null, 2)}\n`);
  return { casesPath, cases };
}

if (import.meta.main) {
  const [out, ...flags] = process.argv.slice(2);
  if (!out) {
    console.error("usage: node test/fixtures/identity-set/build.ts <out-dir> [--no-raccoon-world]");
    process.exit(2);
  }
  const { casesPath, cases } = await buildIdentitySet(resolve(out), {
    raccoonWorld: !flags.includes("--no-raccoon-world"),
  });
  console.log(`${cases.length} cases: ${casesPath}`);
}
