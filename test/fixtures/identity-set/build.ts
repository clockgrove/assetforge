/**
 * Builds #92's identity acceptance set: the synthetic bird cast drawn in code (birds.ts), with one
 * cases file for `assetgrove identity-eval --cases <out>/cases.json`. Nothing it writes belongs in
 * the repository.
 *
 *   node test/fixtures/identity-set/build.ts <out-dir> [--held-out <run>]
 *
 * With `--held-out "#104 run 7"`, cases.json holds only that run's held-out cut (see heldOutCut).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildBirdCastSet } from "./birds.ts";

interface PathCase {
  image: string;
  bible?: string;
}

/**
 * The held-out cut of one run, as decisions.md reports it: the positives and drift that run added
 * (`heldOut` equal to `run`), with every generic and look-alike negative. Other cases are left out.
 */
export function heldOutCut<T extends { kind?: unknown; heldOut?: unknown }>(
  cases: T[],
  run: string,
): T[] {
  return cases.filter((c) => c.heldOut === run || c.kind === "generic" || c.kind === "lookalike");
}

/** The bird cast under `outDir`, and one cases file whose paths are relative to it. */
export async function buildIdentitySet(
  outDir: string,
  options: { heldOut?: string } = {},
): Promise<{ casesPath: string; cases: unknown[] }> {
  let cases: Array<Record<string, unknown>> = [];
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
  if (options.heldOut !== undefined) {
    const run = options.heldOut;
    if (!cases.some((c) => c.heldOut === run)) throw new Error(`no case is held out for "${run}"`);
    cases = heldOutCut(cases, run);
  }
  const casesPath = join(outDir, "cases.json");
  await writeFile(casesPath, `${JSON.stringify(cases, null, 2)}\n`);
  return { casesPath, cases };
}

if (import.meta.main) {
  const [out, ...flags] = process.argv.slice(2);
  const at = flags.indexOf("--held-out");
  const heldOut = at === -1 ? undefined : flags[at + 1];
  if (!out || (at !== -1 && heldOut === undefined)) {
    console.error("usage: node test/fixtures/identity-set/build.ts <out-dir> [--held-out <run>]");
    process.exit(2);
  }
  const { casesPath, cases } = await buildIdentitySet(resolve(out), {
    ...(heldOut !== undefined && { heldOut }),
  });
  console.log(`${cases.length} cases: ${casesPath}`);
}
