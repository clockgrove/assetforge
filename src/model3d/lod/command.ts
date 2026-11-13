/**
 * `assetforge lod`: makes the detail-level chain and tier renditions the target profile declares
 * (assetforge#136) from a staged candidate or a given `.glb`, checks each level against the full
 * model, and stages the result as a one-candidate run that `pick` hands off. No model is called
 * and nothing is spent.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { InputError } from "../../errors.ts";
import { readRun, writeRun } from "../../loop.ts";
import type { RunRecord, StagedCandidate } from "../../loop.ts";
import { sha256 } from "../../request.ts";
import type { AssetSpec, Provenance, TargetProfile } from "../../types.ts";
import { GLB_MEDIA_TYPE, parseGlb } from "../glb.ts";
import type { Glb } from "../glb.ts";
import { model3dSettings } from "../profile.ts";
import { budgetChecks, hierarchyCheck, qaPassed, validatorCheck } from "../qa.ts";
import { profileSha256 } from "../rig/candidate.ts";
import { boundsOf, clips, imageSize, measure, posedPrimitives, yawBetween } from "../scene.ts";
import { buildChain } from "./chain.ts";
import { lodSettings } from "./settings.ts";
import type { SideFile } from "./textures.ts";

export const LOD_STEP = "lod-chain";
export const LOD_METHOD =
  "meshoptimizer simplifyWithAttributes on index lists only (kept vertices copied byte for byte)";

export interface LodOptions {
  /** A staged candidate: its run directory and id. */
  run?: { dir: string; candidate: string };
  /** Or a `.glb` and the provenance it was handed off with, with the spec it was made for. */
  model?: { bytes: Uint8Array; path: string };
  provenance?: Provenance;
  spec?: AssetSpec;
  specDir?: string;
  /** The target profile; defaults to the staged run's. */
  profile?: TargetProfile;
  runsDir: string;
  runId?: string;
  now?: () => Date;
}

interface Source {
  bytes: Uint8Array;
  sides: SideFile[];
  fields: Record<string, unknown>;
  provenance: Provenance;
  spec: AssetSpec;
  specDir: string;
  profile: TargetProfile;
  bibleVersion: string;
  name: string;
}

async function stagedSource(options: LodOptions): Promise<Source> {
  const { dir, candidate: id } = options.run!;
  const record = await readRun(dir);
  const candidate = record.candidates.find((c) => c.id === id);
  if (!candidate) {
    const ids = record.candidates.map((c) => c.id).join(", ") || "none";
    throw new InputError(
      `"${id}" is not a staged candidate of run ${record.runId} (staged: ${ids})`,
    );
  }
  if (candidate.mediaType !== GLB_MEDIA_TYPE) {
    throw new InputError(`candidate ${id} is not a .glb (${candidate.mediaType})`);
  }
  const read = async (file: string, hash: string) => {
    const bytes = new Uint8Array(await readFile(join(dir, file)));
    if (sha256(bytes) !== hash) throw new InputError(`staged file ${file} changed since staging`);
    return bytes;
  };
  const sides: SideFile[] = [];
  for (const s of candidate.sidecars ?? []) {
    sides.push({
      name: s.name,
      bytes: await read(s.file, s.sha256),
      mediaType: s.mediaType,
      field: s.field,
      ...(s.extra !== undefined && { extra: s.extra }),
    });
  }
  return {
    bytes: await read(candidate.file, candidate.sha256),
    sides,
    fields: candidate.fields,
    provenance: candidate.provenance,
    spec: options.spec ?? record.spec,
    specDir: options.specDir ?? record.specDir,
    profile: options.profile ?? record.profile,
    bibleVersion: record.bibleVersion,
    name: candidate.file,
  };
}

/**
 * The side images a given model references by a plain relative `uri` inside its directory (a
 * look-dev'd model's groom maps, tint and eye mask), each with the output field look-dev gave it.
 */
async function sidesBeside(glb: Glb, dir: string): Promise<SideFile[]> {
  const extras = glb.json.asset.extras as
    | {
        lookdev?: {
          images?: Record<string, { image?: number }>;
          groom?: { maxLengthM?: Record<string, number> };
          eyes?: { material?: string };
        };
      }
    | undefined;
  const fieldOf = new Map(
    Object.entries(extras?.lookdev?.images ?? {}).map(([field, e]) => [e.image, field]),
  );
  const out: SideFile[] = [];
  for (const [index, image] of (glb.json.images ?? []).entries()) {
    const uri = image.uri;
    if (uri === undefined || /^[a-z][a-z0-9+.-]*:/i.test(uri)) continue;
    const path = decodeURIComponent(uri);
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) continue;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(dir, path)));
    } catch {
      continue; // The validator names an image it cannot load.
    }
    const field = fieldOf.get(index) ?? `images.${index}`;
    const season = /^groom\.([^.]+)\.length$/.exec(field)?.[1];
    const maxLengthM =
      field === "groom.length"
        ? Object.values(extras?.lookdev?.groom?.maxLengthM ?? {})[0]
        : season && extras?.lookdev?.groom?.maxLengthM?.[season];
    const material = field === "eyes" ? extras?.lookdev?.eyes?.material : undefined;
    out.push({
      name: path,
      bytes,
      mediaType: image.mimeType ?? "image/png",
      field,
      ...(typeof maxLengthM === "number" && { extra: { maxLengthM } }),
      ...(material && { extra: { material } }),
    });
  }
  return out;
}

/** The clip and rig fields of a given model, read from the file (`extras.loop`, `asset.extras.rig`). */
function fieldsOf(glb: Glb, provenance: Provenance, spec: AssetSpec): Record<string, unknown> {
  const rig = (glb.json.asset.extras as { rig?: unknown } | undefined)?.rig;
  const missing = (provenance.parameters as Record<string, unknown> | undefined)?.["missingClips"];
  return {
    clips: clips(glb).map((clip) => {
      const extras = glb.json.animations?.[clip.index]?.["extras"] as
        { loop?: boolean; generated?: boolean } | undefined;
      return {
        name: clip.name,
        durationMs: Math.round(clip.durationS * 1000),
        loop: extras?.loop === true,
        ...(extras?.generated === true && { generated: true }),
      };
    }),
    ...(rig !== undefined && { rig }),
    ...(Array.isArray(missing) && { missingClips: missing }),
    ...(spec.gait !== undefined && { gait: spec.gait }),
  };
}

async function givenSource(options: LodOptions): Promise<Source> {
  const { model, provenance, spec, profile } = options;
  if (!model || !spec || !profile) {
    throw new InputError(
      "lod needs --run and --candidate, or --model, --provenance, --spec and --profile",
    );
  }
  if (!provenance || typeof provenance !== "object" || !Array.isArray(provenance.calls)) {
    throw new InputError("the provenance file is not an Assetforge provenance record");
  }
  const glb = parseGlb(model.bytes);
  return {
    bytes: model.bytes,
    sides: await sidesBeside(glb, dirname(resolve(model.path))),
    fields: fieldsOf(glb, provenance, spec),
    provenance,
    spec,
    specDir: resolve(options.specDir ?? "."),
    profile,
    bibleVersion: provenance.bibleVersion,
    // The file name only: a local path would leak into the target's public provenance.
    name: basename(model.path),
  };
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

export async function lodChain(
  options: LodOptions,
): Promise<{ run: RunRecord; runDir: string; passed: boolean }> {
  const source = options.run ? await stagedSource(options) : await givenSource(options);
  const { spec, profile } = source;
  const settings = model3dSettings(profile);
  const tierClass = (spec as { tierClass?: unknown }).tierClass;
  if (tierClass !== undefined && typeof tierClass !== "string") {
    throw new InputError("the spec's tierClass must be a string");
  }
  const lods = lodSettings(profile, tierClass);
  if (typeof spec.assetId !== "string" || spec.assetId === "") {
    throw new InputError("the spec needs an assetId: the chain's files are named after it");
  }
  const sourceSha256 = sha256(source.bytes);
  const glb = parseGlb(source.bytes);
  const chain = await buildChain({
    source: glb,
    sides: source.sides,
    settings: lods,
    budgets: settings.budgets,
    assetId: spec.assetId,
    sizePx: settings.turntablePx,
    forwardYawDeg: (yawBetween("+z", settings.forward) * 180) / Math.PI,
  });

  // The main file is checked as every 3D candidate is, with its side images resolved.
  const main = parseGlb(chain.bytes);
  const measures = measure(main);
  const resources = Object.fromEntries(source.sides.map((s) => [s.name, s.bytes]));
  measures.unmeasuredImages = measures.unmeasuredImages.filter((index) => {
    const uri = main.json.images?.[index]?.uri;
    const size =
      uri === undefined
        ? undefined
        : imageSize(resources[decodeURIComponent(uri)] ?? new Uint8Array());
    if (!size) return true;
    measures.textureMaxPx = Math.max(measures.textureMaxPx, size.width, size.height);
    return false;
  });
  const reasons = [
    await validatorCheck(chain.bytes, resources),
    hierarchyCheck(main, measures),
    ...budgetChecks(measures, settings),
  ];
  for (const side of chain.sidecars) {
    if (side.mediaType !== GLB_MEDIA_TYPE) continue;
    const own = Object.fromEntries(
      chain.sidecars.filter((s) => s.mediaType !== GLB_MEDIA_TYPE).map((s) => [s.name, s.bytes]),
    );
    const verdict = await validatorCheck(side.bytes, { ...resources, ...own });
    reasons.push({ ...verdict, check: `gltf-validator-${side.name}` });
  }
  reasons.push(...chain.reasons);
  reasons.push({
    check: "turntable",
    passed: chain.artifacts.length > 0,
    reason: `${chain.artifacts.length} render(s) of the levels and tiers: ${chain.artifacts.map((a) => a.name).join(", ")}`,
    source: "deterministic",
  });

  const now = options.now ?? (() => new Date());
  const runId =
    options.runId ??
    `${now().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = resolve(options.runsDir, runId);
  const id = "c1";
  const folder = `${id}-lod`;
  await mkdir(join(runDir, folder), { recursive: true });
  const artifacts: string[] = [];
  for (const artifact of chain.artifacts) {
    const name = join(folder, artifact.name);
    await writeFile(join(runDir, name), artifact.bytes);
    artifacts.push(name);
  }

  const bounds = boundsOf(posedPrimitives(main));
  const fields: Record<string, unknown> = {
    ...source.fields,
    triangles: measures.triangles,
    textureMaxPx: measures.textureMaxPx,
    materials: measures.materials,
    bones: measures.bones,
    lods: measures.lods,
    ...(bounds && { bounds: { min: bounds.min.map(round), max: bounds.max.map(round) } }),
    chain: {
      packaging: lods.packaging,
      levels: chain.levels,
      tiers: chain.tiers.map(({ name, levels, textureMaxPx }) => ({ name, levels, textureMaxPx })),
    },
  };
  const outputs = [chain.bytes, ...chain.sidecars.map((s) => s.bytes)].map((b) => sha256(b));
  const parameters = {
    ...source.provenance.parameters,
    targetProfileSha256: profileSha256(profile),
    lod: {
      source: basename(source.name),
      sourceSha256,
      method: LOD_METHOD,
      packaging: lods.packaging,
      silhouetteTolerance: lods.silhouette,
      levels: chain.levels,
      tiers: lods.tiers,
    },
  };
  const record: Provenance = {
    ...source.provenance,
    parameters,
    steps: [
      ...(source.provenance.steps ?? []),
      {
        op: LOD_STEP,
        params: { method: LOD_METHOD, packaging: lods.packaging, levels: chain.levels },
        engine: { name: "assetforge-lod", version: "1" },
        inputs: [sourceSha256],
        outputs,
      },
    ],
  };
  const passed = qaPassed(reasons);
  const run: RunRecord = {
    runId,
    createdAt: now().toISOString(),
    spec,
    specDir: source.specDir,
    profile,
    bibleVersion: source.bibleVersion,
    capUsd: 0,
    estimateUsd: 0,
    spentUsd: 0,
    requested: 1,
    candidates: [],
    filtered: passed ? 0 : 1,
    errors: [],
  };
  if (passed) {
    const file = `${id}.glb`;
    await writeFile(join(runDir, file), chain.bytes);
    const sidecars: NonNullable<StagedCandidate["sidecars"]> = [];
    for (const side of chain.sidecars) {
      const staged = join(folder, "files", side.name);
      await mkdir(join(runDir, folder, "files"), { recursive: true });
      await writeFile(join(runDir, staged), side.bytes);
      sidecars.push({
        file: staged,
        name: side.name,
        mediaType: side.mediaType,
        sha256: sha256(side.bytes),
        field: side.field,
        ...(side.extra !== undefined && { extra: side.extra }),
      });
    }
    run.candidates.push({
      id,
      file,
      mediaType: GLB_MEDIA_TYPE,
      extension: "glb",
      sha256: sha256(chain.bytes),
      reasons,
      fields,
      provenance: record,
      artifacts,
      ...(sidecars.length > 0 && { sidecars }),
    });
  } else {
    run.rejections = [{ candidate: 1, reasons, costUsd: 0, artifacts }];
  }
  await writeRun(runDir, run);
  return { run, runDir, passed };
}
