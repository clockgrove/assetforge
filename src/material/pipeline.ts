import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Caller } from "../calls.ts";
import { InputError } from "../errors.ts";
import { decodeImage, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { sha256 } from "../request.ts";
import type { AssetSpec, LoadedReference, QaResult, Reason, TargetProfile } from "../types.ts";
import { CORE_METHODS, temporalChecks, validateMaterialMap } from "./core.ts";
import type { MaterialChannel } from "./core.ts";

export type { MaterialProfile } from "./profile.ts";
import { resolveMaterialProfile } from "./profile.ts";
import { targetCommand } from "./engine.ts";
import { runRecipeAsync } from "../transform/run.ts";
import type { TransformStep, ImageItem } from "../transform/types.ts";
export interface MaterialDerivation {
  maps: Partial<
    Record<
      MaterialChannel,
      {
        method: "mask-extraction" | "model-assisted-painting" | "height-derived-normal";
        version: string;
        path?: string;
        component?: "red" | "alpha" | "luminance";
        strength?: number;
      }
    >
  >;
  lightSources?: { name: string; mask: string }[];
}

export interface MaterialOutput {
  channel: MaterialChannel | "albedo";
  scale: number;
  path: string;
  sha256: string;
  mediaType: string;
  width: number;
  height: number;
}

const LIT_CHECKS = [
  "flat-albedo",
  "normal-orientation",
  "emissive-placement",
  "dusk-rain",
  "night",
];

function imageReference(bytes: Uint8Array, role: string, path: string): LoadedReference {
  return { bytes, mediaType: "image/png", role, path, sha256: sha256(bytes) };
}

function parseLit(text: string): Reason[] {
  let checks: unknown;
  try {
    checks = (JSON.parse(text) as { checks?: unknown }).checks;
  } catch {
    checks = undefined;
  }
  return LIT_CHECKS.map((check) => {
    const matches = Array.isArray(checks)
      ? checks.filter((c: { check?: unknown }) => c?.check === check)
      : [];
    const c =
      matches.length === 1 ? (matches[0] as { passed?: unknown; reason?: unknown }) : undefined;
    return {
      check,
      passed: c?.passed === true,
      reason: typeof c?.reason === "string" ? c.reason : "missing or unreadable lit QA verdict",
      source: "vision",
    };
  });
}

export async function runMaterials(options: {
  albedoPath: string;
  spec: AssetSpec;
  profile: TargetProfile;
  derivation: MaterialDerivation;
  baseDir: string;
  profileDir?: string;
  outDir: string;
  call: Caller;
}): Promise<{ passed: boolean; reportPath: string; outputs: MaterialOutput[]; qa: QaResult }> {
  const startedAt = new Date().toISOString();
  const outDir = resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const reportPath = join(outDir, "materials.json");
  await rm(reportPath, { force: true });
  const { spec, profile, derivation, call } = options;
  const config = resolveMaterialProfile(profile.style?.materials);
  const steps: TransformStep[] = [];
  const commandResults: unknown[] = [];
  const recipeItem = (raster: Raster, name: string): ImageItem => ({
    name,
    raster,
    mediaType: "image/png",
    meta: {},
  });
  const recipe = async (op: string, params: Record<string, unknown>, raster: Raster) => {
    const result = await runRecipeAsync({ steps: [{ op, params }] }, [recipeItem(raster, op)], {
      materialCall: call,
    });
    steps.push(...result.steps);
    return result.items[0]!.raster;
  };
  if (!derivation || !derivation.maps)
    throw new InputError("material derivation maps are required");
  const grid = {
    width: spec.frames?.width ?? profile.frames.width,
    height: spec.frames?.height ?? profile.frames.height,
    count: spec.frames?.count ?? 1,
  };
  if (Object.values(grid).some((n) => !Number.isInteger(n) || n < 1))
    throw new InputError("invalid material frame grid");
  const albedoBytes = new Uint8Array(await readFile(options.albedoPath));
  const albedo = decodeImage(albedoBytes);
  const native = albedo.height / grid.height;
  if (
    !Number.isInteger(native) ||
    albedo.width !== grid.width * grid.count * native ||
    native < Math.max(...config.scales)
  )
    throw new InputError(
      "albedo native resolution cannot support requested renditions without upscaling",
    );
  const nativeGrid = {
    width: grid.width * native,
    height: grid.height * native,
    count: grid.count,
  };
  const mapSources = new Map<
    MaterialChannel,
    {
      raster: Raster;
      method: string;
      version: string;
      inputHash: string;
      parameters: Record<string, unknown>;
    }
  >();
  const ref = imageReference(albedoBytes, "neutral-key-light albedo", resolve(options.albedoPath));
  const sources = await Promise.all(
    (derivation.lightSources ?? []).map(async (s) => ({
      name: s.name,
      mask: decodeImage(new Uint8Array(await readFile(resolve(options.baseDir, s.mask)))),
    })),
  );
  const names = spec.fields?.["lightSources"];
  if (names !== undefined && (!Array.isArray(names) || names.some((n) => typeof n !== "string")))
    throw new InputError("spec.fields.lightSources must be source names");
  const namedLightSources = (names ?? []) as string[];
  for (const source of sources)
    if (!namedLightSources.includes(source.name))
      throw new InputError(`emissive source is not named in the spec: ${source.name}`);
  const derive = async (channel: MaterialChannel): Promise<Raster> => {
    const existing = mapSources.get(channel);
    if (existing) return existing.raster;
    const input = derivation.maps[channel];
    if (!input || !input.version?.trim())
      throw new InputError(`missing declared method/version for ${channel}`);
    if (input.method === "height-derived-normal" && channel !== "normal")
      throw new InputError("height-derived-normal is only valid for normals");
    const source = input.method === "height-derived-normal" ? await derive("height") : albedo;
    const params = {
      grid: nativeGrid,
      method: input.method,
      version: input.version,
      component: input.component ?? "red",
      strength: (input.strength ?? 1) * native,
      lightSources: namedLightSources,
      ...(input.path ? { path: resolve(options.baseDir, input.path) } : {}),
    };
    const raster = await recipe(`material-${channel}`, params, source);
    const inputHash = steps.at(-1)!.report!["inputHash"] as string;
    mapSources.set(channel, {
      raster,
      method: input.method,
      version: input.version,
      inputHash,
      parameters: {
        component: input.component ?? "red",
        strength: input.strength ?? 1,
        strengthUnits: "per-base-pixel",
        nativeStrength: (input.strength ?? 1) * native,
      },
    });
    return raster;
  };
  for (const channel of config.channels) await derive(channel);
  const reasons: Reason[] = [];
  for (const channel of config.channels) {
    const map = mapSources.get(channel)!.raster;
    const encoding = config.encoding?.[channel];
    if (encoding && encoding.encoding !== "unorm8")
      throw new InputError(`unsupported material encoding for ${channel}`);
    const bound =
      typeof config.flickerBound === "number"
        ? config.flickerBound
        : config.flickerBound?.[channel];
    if (bound === undefined) throw new InputError(`missing flicker bound for ${channel}`);
    reasons.push(
      ...[
        ...validateMaterialMap(albedo, map, nativeGrid, channel, {
          range: encoding?.range,
          emissiveSources: sources,
          namedLightSources,
        }),
        ...temporalChecks(albedo, map, nativeGrid, bound),
      ].map((r) => ({ ...r, reason: `${channel}: ${r.reason}` })),
    );
  }
  const outputs: MaterialOutput[] = [];
  const sidecars = new Map<string, Record<string, unknown>>();
  let litComplete = false;
  const common = {
    startedAt,
    license: profile.license,
    profileHash: sha256(Buffer.from(JSON.stringify(profile))),
    specHash: sha256(Buffer.from(JSON.stringify(spec))),
    derivationHash: sha256(Buffer.from(JSON.stringify(derivation))),
    lightSources: sources.map((s) => ({ name: s.name, sha256: sha256(encodePng(s.mask)) })),
    generator: "assetforge-materials",
    version: "1",
    assetId: spec.assetId,
    source: { path: resolve(options.albedoPath), sha256: sha256(albedoBytes), nativeScale: native },
    grid,
    upscalerUsed: false,
    review: "pending",
    calls: call.records,
  };
  const writeReport = async () => {
    const qa = {
      passed: litComplete && reasons.length > 0 && reasons.every((r) => r.passed),
      reasons,
    };
    const finishedAt = new Date().toISOString();
    const costUsd = call.records.reduce((sum, c) => sum + c.costUsd, 0);
    for (const [path, record] of sidecars)
      await writeFile(
        path,
        JSON.stringify({ ...record, calls: call.records, finishedAt, costUsd }, null, 2) + "\n",
      );
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          ...common,
          finishedAt,
          costUsd,
          derivations: Object.fromEntries(
            [...mapSources].map(([channel, m]) => [
              channel,
              {
                method: m.method,
                version: m.version,
                inputHash: m.inputHash,
                parameters: m.parameters,
                engine:
                  channel === "normal" && m.method === "height-derived-normal"
                    ? CORE_METHODS.normals
                    : m.method === "mask-extraction"
                      ? CORE_METHODS.extraction
                      : { method: "gateway-model", version: m.version },
              },
            ]),
          ),
          outputs,
          steps,
          commandResults,
          lightRig: config.lightRig,
          qa,
        },
        null,
        2,
      ) + "\n",
    );
    return { passed: qa.passed, reportPath, outputs, qa };
  };
  if (reasons.some((r) => !r.passed)) return writeReport();
  try {
    for (const channel of ["albedo", ...config.channels] as const)
      for (const scale of config.scales) {
        const source = channel === "albedo" ? albedo : mapSources.get(channel)!.raster;
        const rendition = await recipe(
          "material-rendition",
          { grid, scale, native, normal: channel === "normal" },
          source,
        );
        if (channel !== "albedo") {
          const checks = validateMaterialMap(
            rendition,
            rendition,
            { width: grid.width * scale, height: grid.height * scale, count: grid.count },
            channel,
            { range: config.encoding?.[channel]?.range },
          ).filter((r) => r.check === "material-range");
          reasons.push(
            ...checks.map((r) => ({ ...r, reason: `${channel}@${scale}x: ${r.reason}` })),
          );
          if (checks.some((r) => !r.passed)) return writeReport();
        }
        const path = join(outDir, `${channel}@${scale}x.png`);
        const bytes = encodePng(rendition);
        await writeFile(path, bytes);
        const output = {
          channel,
          scale,
          path,
          sha256: sha256(bytes),
          mediaType: "image/png",
          width: rendition.width,
          height: rendition.height,
        };
        outputs.push(output);
        const derived =
          channel === "albedo"
            ? { method: "native-albedo", version: "1", inputHash: sha256(albedoBytes) }
            : mapSources.get(channel)!;
        const provenance = {
          ...common,
          ...output,
          steps: [...steps],
          derivation: {
            method: derived.method,
            version: derived.version,
            inputHash: derived.inputHash,
            parameters: "parameters" in derived ? derived.parameters : {},
          },
          encoding: channel === "normal" ? "tangent-space-positive-y-unorm8" : "unorm8",
          range: channel === "albedo" ? [0, 1] : (config.encoding?.[channel]?.range ?? [0, 1]),
        };
        sidecars.set(`${path}.provenance.json`, {
          ...provenance,
          engine:
            channel === "normal" && derived.method === "height-derived-normal"
              ? CORE_METHODS.normals
              : derived.method === "mask-extraction"
                ? CORE_METHODS.extraction
                : { method: derived.method, version: derived.version },
        });
        if (config.compression) {
          if (!config.compression.version?.trim())
            throw new InputError("compression version required");
          const compressed = path.replace(/\.png$/, ".ktx2");
          await recipe(
            "material-encode",
            {
              command: config.compression.command,
              version: config.compression.version,
              input: path,
              output: compressed,
              cwd: options.profileDir ?? options.baseDir,
            },
            rendition,
          );
          commandResults.push(steps.at(-1)!.report);
          const packed = new Uint8Array(await readFile(compressed));
          const compressedOutput = {
            ...output,
            path: compressed,
            sha256: sha256(packed),
            mediaType: "image/ktx2",
          };
          outputs.push(compressedOutput);
          sidecars.set(`${compressed}.provenance.json`, {
            ...sidecars.get(`${path}.provenance.json`),
            ...compressedOutput,
            steps: [...steps],
            compression: {
              version: config.compression.version,
              command: config.compression.command,
            },
          });
        }
      }
    await writeReport();
    if (!config.preview?.version?.trim())
      throw new InputError("target preview command and version are required");
    const previews: LoadedReference[] = [ref];
    for (const scene of ["dusk-rain", "night"]) {
      const path = join(outDir, `${scene}.png`);
      const execution = await targetCommand(
        config.preview.command,
        {
          materials: reportPath,
          output: path,
          scene,
          lightRig: JSON.stringify(config.lightRig ?? {}),
        },
        options.profileDir ?? options.baseDir,
      );
      commandResults.push(execution);
      const bytes = new Uint8Array(await readFile(path));
      const raster = decodeImage(bytes);
      if (raster.width < 1 || raster.height < 1)
        throw new InputError("target preview returned an empty image");
      previews.push(imageReference(bytes, `target render ${scene}`, path));
      sidecars.set(`${path}.provenance.json`, {
        ...common,
        path,
        sha256: sha256(bytes),
        preview: {
          scene,
          version: config.preview.version,
          command: config.preview.command,
          lightRig: config.lightRig,
          execution,
        },
      });
    }
    const text = await call.vision(
      "material-qa",
      `Image 1 is the flat albedo under neutral key light; image 2 is the target renderer at dusk in rain; image 3 is the target renderer at night. Compare all frames and reject inverted normals, misaligned edges, incorrect wetness/flow response and misplaced glow. Only these spec-named sources may emit: ${namedLightSources.join(", ") || "none"}. Return ONLY JSON {"checks":[{"check":"flat-albedo","passed":true,"reason":"..."},...]} with exactly one verdict for each: ${LIT_CHECKS.join(", ")}.`,
      previews,
    );
    reasons.push(...parseLit(text));
    litComplete = true;
    await writeFile(
      join(outDir, "preview.html"),
      '<!doctype html><meta charset="utf-8"><title>Material review</title><p>Review pending</p><div style="display:flex;gap:1em">' +
        ["albedo@1x.png", "dusk-rain.png", "night.png"]
          .map((name) => `<figure><img src="${name}"><figcaption>${name}</figcaption></figure>`)
          .join("") +
        "</div>",
    );
    const htmlPath = join(outDir, "preview.html");
    sidecars.set(`${htmlPath}.provenance.json`, {
      ...common,
      path: htmlPath,
      sha256: sha256(new Uint8Array(await readFile(htmlPath))),
      method: "material-review-html",
      version: "1",
    });
  } catch (error) {
    if (error && typeof error === "object" && "commandRecord" in error)
      commandResults.push(error.commandRecord);
    reasons.push({
      check: "material-delivery",
      passed: false,
      reason: error instanceof Error ? error.message : String(error),
      source: "deterministic",
    });
    await writeReport();
    throw error;
  }
  return writeReport();
}
