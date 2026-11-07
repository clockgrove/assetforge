import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Caller } from "../calls.ts";
import { InputError } from "../errors.ts";
import { createRaster, decodeImage, encodePng, getPixel, setPixel } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { sha256 } from "../request.ts";
import type { AssetSpec, LoadedReference, QaResult, Reason, TargetProfile } from "../types.ts";
import {
  CORE_METHODS,
  deriveNormals,
  extractScalarMap,
  temporalChecks,
  validateMaterialMap,
} from "./core.ts";
import type { MaterialChannel, MaterialGrid } from "./core.ts";

export interface MaterialProfile {
  channels: MaterialChannel[];
  scales: (1 | 2 | 4)[];
  flickerBound: number | Partial<Record<MaterialChannel, number>>;
  encoding?: Partial<Record<MaterialChannel, { range: [number, number]; encoding: "unorm8" }>>;
  compression?: { command: string[]; version: string };
  preview: { command: string[]; version: string };
}

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

const execute = promisify(execFile);
const CHANNELS: MaterialChannel[] = ["normal", "height", "emissive", "roughness", "wind"];
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

async function command(args: string[], values: Record<string, string>, cwd: string): Promise<void> {
  if (!Array.isArray(args) || !args.length || args.some((x) => typeof x !== "string" || !x)) {
    throw new InputError("material target command must be a nonempty argument array");
  }
  const expanded = args.map((arg) =>
    arg.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
      if (values[key] === undefined)
        throw new InputError(`unknown material command placeholder: ${key}`);
      return values[key];
    }),
  );
  if (values["output"]) await rm(values["output"], { force: true });
  await execute(expanded[0] as string, expanded.slice(1), {
    cwd,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
}

function downsample(
  source: Raster,
  grid: MaterialGrid,
  scale: number,
  native: number,
  normal: boolean,
): Raster {
  const factor = native / scale;
  const out = createRaster(grid.width * grid.count * scale, grid.height * scale);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const sums = [0, 0, 0];
      let alpha = 0;
      for (let sy = Math.floor(y * factor); sy < Math.ceil((y + 1) * factor); sy++)
        for (let sx = Math.floor(x * factor); sx < Math.ceil((x + 1) * factor); sx++) {
          const weight =
            (Math.min((x + 1) * factor, sx + 1) - Math.max(x * factor, sx)) *
            (Math.min((y + 1) * factor, sy + 1) - Math.max(y * factor, sy));
          const p = getPixel(source, sx, sy);
          alpha += p[3] * weight;
          for (let c = 0; c < 3; c++)
            sums[c] =
              (sums[c] ?? 0) +
              (normal ? (p[c] as number) / 127.5 - 1 : (p[c] as number)) * p[3] * weight;
        }
      if (!alpha) continue;
      let rgb = sums.map((v) => v / alpha);
      if (normal) {
        const length = Math.hypot(...rgb);
        rgb = length ? rgb.map((v) => (v / length + 1) * 127.5) : [128, 128, 255];
      }
      setPixel(out, x, y, [...rgb.map(Math.round), Math.round(alpha / (factor * factor))]);
    }
  return out;
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

/** Validate a KTX2 container and its level data; the target is responsible for the actual codec. */
function checkCompressed(bytes: Uint8Array, width: number, height: number): void {
  const signature = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 104 || signature.some((v, i) => bytes[i] !== v))
    throw new InputError("compressor did not produce KTX2");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vk = view.getUint32(12, true),
    scheme = view.getUint32(44, true);
  if (
    view.getUint32(20, true) !== width ||
    view.getUint32(24, true) !== height ||
    view.getUint32(28, true) !== 0 ||
    view.getUint32(32, true) !== 0 ||
    view.getUint32(36, true) !== 1 ||
    !view.getUint32(40, true)
  )
    throw new InputError("KTX2 dimensions or levels do not match rendition");
  // KTX 2.0 §3.10: BasisLZ uses ETC1S (163); UASTC (166) permits optional Zstandard.
  const blockCompressed =
    ((vk >= 131 && vk <= 184) || (vk >= 1000066000 && vk <= 1000066013)) &&
    [0, 2, 3].includes(scheme);
  const dfdOffset = view.getUint32(48, true),
    dfdLength = view.getUint32(52, true);
  const basisDfd = dfdLength >= 28 && dfdOffset >= 104 && dfdOffset + dfdLength <= bytes.length;
  const model = basisDfd ? bytes[dfdOffset + 12] : undefined;
  if (!(
    blockCompressed ||
    (vk === 0 &&
      basisDfd &&
      ((scheme === 1 && model === 163) || ([0, 2].includes(scheme) && model === 166)))
  ))
    throw new InputError("KTX2 is not GPU-compressed/Basis");
  const levels = view.getUint32(40, true);
  if (80 + levels * 24 > bytes.length) throw new InputError("truncated KTX2 level index");
  for (let i = 0; i < levels; i++) {
    const offset = Number(view.getBigUint64(80 + i * 24, true));
    const length = Number(view.getBigUint64(88 + i * 24, true));
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      offset < 80 + levels * 24 ||
      offset + length > bytes.length
    )
      throw new InputError("truncated KTX2 level data");
  }
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
  const config = profile.style?.materials;
  if (
    !config ||
    !Array.isArray(config.channels) ||
    config.channels.length === 0 ||
    new Set(config.channels).size !== config.channels.length ||
    config.channels.some((c) => !CHANNELS.includes(c))
  )
    throw new InputError("profile requires unique material channels");
  if (
    !Array.isArray(config.scales) ||
    !config.scales.includes(1) ||
    !config.scales.includes(2) ||
    config.scales.some((s) => ![1, 2, 4].includes(s)) ||
    new Set(config.scales).size !== config.scales.length
  )
    throw new InputError("material scales require 1 and 2, optionally 4");
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
    let raster: Raster, inputHash: string;
    if (input.method === "height-derived-normal") {
      if (channel !== "normal")
        throw new InputError("height-derived-normal is only valid for normals");
      const height = await derive("height");
      raster = deriveNormals(height, nativeGrid, (input.strength ?? 1) * native);
      inputHash = sha256(encodePng(height));
    } else {
      let bytes: Uint8Array;
      if (input.method === "mask-extraction") {
        if (!input.path) throw new InputError(`missing extraction source path for ${channel}`);
        bytes = new Uint8Array(await readFile(resolve(options.baseDir, input.path)));
      } else if (input.method === "model-assisted-painting") {
        const image = await call.image(
          `material-${channel}`,
          `Derive an aligned ${channel} material map from image 1. Preserve every frame's pose and alpha bounds. ${channel === "normal" ? "Encode tangent-space +Y normals in normalized RGB." : "Encode scalar values as grayscale [0,1]."} Emissive light sources allowed: ${namedLightSources.join(", ") || "none"}. Do not add any unnamed light source. Method version: ${input.version}.`,
          [ref],
        );
        bytes = image.bytes;
      } else throw new InputError(`unknown derivation method for ${channel}`);
      inputHash = sha256(bytes);
      const source = decodeImage(bytes);
      raster =
        channel === "normal"
          ? source
          : extractScalarMap(albedo, source, nativeGrid, { component: input.component });
    }
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
        const rendition = downsample(source, grid, scale, native, channel === "normal");
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
          await command(
            config.compression.command,
            { input: path, output: compressed },
            options.profileDir ?? options.baseDir,
          );
          const packed = new Uint8Array(await readFile(compressed));
          checkCompressed(packed, rendition.width, rendition.height);
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
      await command(
        config.preview.command,
        { materials: reportPath, output: path, scene },
        options.profileDir ?? options.baseDir,
      );
      const bytes = new Uint8Array(await readFile(path));
      const raster = decodeImage(bytes);
      if (raster.width < 1 || raster.height < 1)
        throw new InputError("target preview returned an empty image");
      previews.push(imageReference(bytes, `target render ${scene}`, path));
      sidecars.set(`${path}.provenance.json`, {
        ...common,
        path,
        sha256: sha256(bytes),
        preview: { scene, version: config.preview.version, command: config.preview.command },
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
