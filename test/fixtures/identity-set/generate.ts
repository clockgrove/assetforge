/**
 * Makes #92's generated identity cases through the gateway: on-style generic raccoons (the `still`
 * route, no reference) and model-edited drift of approved references (the `edit` route, or the
 * `still` route with the reference where the edit model did not make the change). Each
 * label comes from how the image was made. The outputs are committed under `generated/`, with
 * every call's provenance in `generated/provenance.json`, so the set of record is rebuilt without
 * paying again; this script only makes the items whose image is missing. Paid and opt-in: it needs
 * AI_GATEWAY_API_KEY, reserves every call against `--cap` and the spend ledger, and refuses
 * without a key.
 *
 *   node test/fixtures/identity-set/generate.ts [--cap 5] [--only <id>]...
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Budget } from "../../../src/budget.ts";
import { Caller } from "../../../src/calls.ts";
import { VercelGateway } from "../../../src/gateway/vercel.ts";
import { decodeImage, encodePng } from "../../../src/image/raster.ts";
import type { Raster } from "../../../src/image/raster.ts";
import { resampleTo } from "../../../src/image/resample.ts";
import { defaultRoutes } from "../../../src/routes.ts";
import { SpendLedger } from "../../../src/spend.ts";
import type { CallRecord } from "../../../src/types.ts";

export interface GeneratedItem {
  id: string;
  /** `same`: an on-model frame of `subject` cut from an Assetforge `generate-sheet` import. */
  kind: "generic" | "drift" | "same";
  route: "still" | "edit" | "sheet";
  /** Generic: what the prompt asks for, put into `genericPrompt`. */
  what?: string;
  /** Drift: whose approved reference was edited, the reference, the edit and the drift it makes. */
  subject?: string;
  from?: string;
  edit?: string;
  drift?: string;
  seed?: number;
  /** When and what was checked by eye before the image was kept. */
  checked?: string;
}

export interface GeneratedManifest {
  repository: string;
  commit: string;
  cast: string;
  /** Every identity in the cast; a generic is a negative against each of them. */
  subjects: string[];
  maxSide: number;
  genericPrompt: string;
  editSuffix: string;
  items: GeneratedItem[];
  /** Items made and then dropped because the image did not show what the recipe asked for. */
  dropped?: { id: string; reason: string }[];
}

export interface GeneratedProvenance {
  id: string;
  sha256: string;
  source?: { path: string; sha256: string };
  /** Still and edit items: the generation call. */
  call?: CallRecord;
  /** Sheet items: the `generate-sheet` import the frame was cut from. */
  sheet?: {
    importId: string;
    createdAt: string;
    tool: string;
    sheetSha256: string;
    frame: string;
    assetforge: string;
  };
}

export const GENERATED_DIR = new URL("./generated/", import.meta.url);

export async function loadGeneratedManifest(): Promise<GeneratedManifest> {
  return JSON.parse(
    await readFile(new URL("./generated.json", import.meta.url), "utf8"),
  ) as GeneratedManifest;
}

export function promptFor(manifest: GeneratedManifest, item: GeneratedItem): string {
  if (item.kind === "same")
    throw new Error(`${item.id}: a sheet frame is made with generate-sheet, not regenerated here`);
  if (item.kind === "generic") return manifest.genericPrompt.replace("{what}", item.what ?? "");
  return `${item.edit ?? ""}${manifest.editSuffix}`;
}

/** Shrinks so the longer side is at most `maxSide`; smaller images are kept as they are. */
export function shrink(src: Raster, maxSide: number): Raster {
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
  if (scale === 1) return src;
  const size = {
    width: Math.max(1, Math.round(src.width * scale)),
    height: Math.max(1, Math.round(src.height * scale)),
  };
  return resampleTo(src, scale, { x: 0, y: 0 }, size, "antialiased");
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function main() {
  const { values } = parseArgs({
    options: {
      cap: { type: "string", default: "5" },
      only: { type: "string", multiple: true },
    },
  });
  const manifest = await loadGeneratedManifest();
  const only = values.only ?? [];
  const provenancePath = new URL("provenance.json", GENERATED_DIR);
  const provenance = JSON.parse(
    await readFile(provenancePath, "utf8").catch(() => "[]"),
  ) as GeneratedProvenance[];
  const todo: GeneratedItem[] = [];
  for (const item of manifest.items) {
    if (only.length > 0 && !only.includes(item.id)) continue;
    const exists = await stat(new URL(`${item.id}.png`, GENERATED_DIR)).catch(() => undefined);
    if (!exists) todo.push(item);
  }
  if (todo.length === 0) {
    console.log("every generated image is already made");
    return;
  }
  const provider = VercelGateway.fromEnv();
  const budget = new Budget(Number(values.cap), SpendLedger.fromEnv(process.env));
  budget.check(
    todo.reduce((sum, item) => sum + defaultRoutes[item.route]!.estimatedCostUsd, 0),
    `${todo.length} generated identity images`,
  );
  const caller = new Caller({
    provider,
    providerName: "vercel-ai-gateway",
    budget,
    routes: defaultRoutes,
  });
  await mkdir(GENERATED_DIR, { recursive: true });
  for (const item of todo) {
    const prompt = promptFor(manifest, item);
    let source: GeneratedProvenance["source"];
    const references = [];
    if (item.kind === "drift") {
      if (!item.from) throw new Error(`${item.id}: drift needs "from"`);
      const url = `https://media.githubusercontent.com/media/${manifest.repository}/${manifest.commit}/${item.from}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      source = { path: item.from, sha256: sha256(bytes) };
      references.push({
        role: "source",
        path: item.from,
        mediaType: "image/png",
        bytes,
        sha256: source.sha256,
      });
    }
    const image = await caller.image(item.route, prompt, references, item.seed);
    const png = encodePng(shrink(decodeImage(image.bytes), manifest.maxSide));
    await writeFile(new URL(`${item.id}.png`, GENERATED_DIR), png);
    const call = caller.records.at(-1)!;
    provenance.push({ id: item.id, sha256: sha256(png), ...(source && { source }), call });
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
    console.log(`${item.id}: $${call.costUsd.toFixed(4)} (${call.costSource})`);
  }
  console.log(`spent $${budget.spentUsd.toFixed(4)}`);
}

if (import.meta.main) await main();
