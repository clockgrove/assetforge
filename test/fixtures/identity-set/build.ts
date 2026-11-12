/**
 * Builds #92's identity acceptance set: the synthetic bird cast (drawn in code) and the Raccoon
 * World cast (downloaded from clockgrove/raccoon-world's public references at the pinned commit),
 * with one cases file for `assetforge identity-eval --cases <out>/cases.json`. Nothing it writes
 * belongs in the repository.
 *
 *   node test/fixtures/identity-set/build.ts <out-dir> [--no-raccoon-world]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildBirdCastSet } from "./birds.ts";
import { buildRaccoonWorldSet } from "./raccoon-world.ts";

interface PathCase {
  image: string;
  bible?: string;
}

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
  if (options.raccoonWorld !== false)
    add(
      "raccoon-world",
      (
        await buildRaccoonWorldSet(
          join(outDir, "raccoon-world"),
          options.fetch ? { fetch: options.fetch } : undefined,
        )
      ).cases,
    );
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
