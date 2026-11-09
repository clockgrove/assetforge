/**
 * The work behind `assetforge animation-qa` and `assetforge fix-frame`, kept apart from argument
 * parsing so tests and the MCP surface can call it directly.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Budget } from "../budget.ts";
import { Caller } from "../calls.ts";
import { InputError } from "../errors.ts";
import type { GenerationProvider } from "../gateway/provider.ts";
import type { PlannedCall } from "../generators/generator.ts";
import { decodeImage, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { embedDigitalSourceType, readDigitalSourceType } from "../metadata.ts";
import type { DigitalSourceType } from "../metadata.ts";
import { loadReference, sniffMediaType } from "../request.ts";
import type { Routes } from "../routes.ts";
import { readImport } from "../sheet/import.ts";
import { resolveStyle } from "../style.ts";
import type { ResolvedStyle } from "../style.ts";
import type { Point, Provenance, Size, TargetProfile } from "../types.ts";
import { DEFAULT_FIX_CAP_USD, fixBaseProvenance, fixFrame, planFix } from "./fix.ts";
import type { FrameFix } from "./fix.ts";
import { planFlicker } from "./flicker.ts";
import { planHoles } from "./holes.ts";
import { measureThreshold, splitStrip } from "./strip.ts";
import { thresholdsFor } from "./templates.ts";
import { defaultAnchor, familyLoops, profileFrame, qaStrip } from "./run.ts";
import type { StripQaResult } from "./run.ts";

/** One strip to check: where it is and how to read it. */
export interface StripTarget {
  family: string;
  path: string;
  frame: Size;
  anchor: Point;
  durationMs?: number;
  style: ResolvedStyle;
  profile: TargetProfile;
  subject: string;
  /** The subject's gait from its asset spec; the profile's `animation.gait` applies when unset. */
  gait?: string;
}

/** QA measures alpha only, so a palette rule needs no palette here. */
export function qaStyle(profile: TargetProfile): ResolvedStyle {
  const style = profile.style;
  return resolveStyle(style && { ...style, color: { rule: "full" } });
}

export function parseAnchor(text: string | undefined): Point | undefined {
  if (text === undefined) return undefined;
  const m = /^(\d+),(\d+)$/.exec(text.trim());
  if (!m) throw new InputError(`--anchor must be x,y in frame pixels, got "${text}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

async function readStrip(path: string): Promise<{ raster: Raster; origin?: DigitalSourceType }> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (error) {
    throw new InputError(`cannot read the strip ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  let raster: Raster;
  try {
    raster = decodeImage(bytes);
  } catch (error) {
    throw new InputError(`cannot decode the strip ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const origin = readDigitalSourceType(bytes, sniffMediaType(bytes));
  return { raster, ...(origin !== undefined && { origin }) };
}

/** The strips of every family an import wrote (`preview/<family>.png` in the import directory). */
export async function importTargets(importDir: string): Promise<StripTarget[]> {
  let record;
  try {
    record = await readImport(importDir);
  } catch (error) {
    throw new InputError(`cannot read the import ${importDir}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const families = [...new Set((record.written ?? []).flatMap((w) => w.families))];
  if (families.length === 0) {
    throw new InputError(`import ${importDir} has written no family yet; run write-families first`);
  }
  return families.map((family) => ({
    family,
    path: join(importDir, "preview", `${family}.png`),
    frame: record.frame,
    anchor: record.anchor,
    ...(record.durationMs !== undefined && { durationMs: record.durationMs }),
    style: record.style,
    profile: record.profile,
    subject: record.subject ?? record.assetId,
    ...(record.gait !== undefined && { gait: record.gait }),
  }));
}

/** One strip given on the command line. */
export function stripTarget(options: {
  path: string;
  family: string;
  profile: TargetProfile;
  subject?: string;
  anchor?: Point;
  gait?: string;
}): StripTarget {
  const frame = profileFrame(options.profile);
  return {
    family: options.family,
    path: options.path,
    frame,
    anchor: options.anchor ?? defaultAnchor(frame),
    ...(options.profile.frames.durationMs !== undefined && {
      durationMs: options.profile.frames.durationMs,
    }),
    style: qaStyle(options.profile),
    profile: options.profile,
    subject: options.subject ?? options.family,
    ...(options.gait !== undefined && { gait: options.gait }),
  };
}

export interface QaPlan {
  calls: number;
  perFamily: Array<{ family: string; calls: number; flickerCalls: number; holeCalls: number }>;
  model: string;
  /** The holes route's model (one call per frame with a see-through area inside its outline). */
  holesModel: string;
  estimateUsd: number;
  capUsd: number;
  withinCap: boolean;
}

/**
 * The vision calls a QA run would make: identity flicker per frame pair, and holes per frame
 * with a see-through area inside its outline (found on pixels, so the plan is exact).
 */
export async function planAnimationQa(
  targets: StripTarget[],
  routes: Routes,
  capUsd: number,
  vision: boolean,
): Promise<QaPlan> {
  const perFamily: QaPlan["perFamily"] = [];
  let estimateUsd = 0;
  for (const t of targets) {
    const { raster } = await readStrip(t.path);
    const count = Math.floor(raster.width / t.frame.width);
    const flicker = vision
      ? planFlicker(count, familyLoops(t.family, t.profile), routes)
      : { calls: 0, estimatedCostUsd: 0 };
    const holes = vision
      ? planHoles(
          splitStrip(raster, t.frame),
          { threshold: measureThreshold(t.style), minPx: thresholdsFor(t.profile).holeMinPx },
          routes,
        )
      : { calls: 0, estimatedCostUsd: 0 };
    perFamily.push({
      family: t.family,
      calls: flicker.calls + holes.calls,
      flickerCalls: flicker.calls,
      holeCalls: holes.calls,
    });
    estimateUsd += flicker.estimatedCostUsd + holes.estimatedCostUsd;
  }
  return {
    calls: perFamily.reduce((s, f) => s + f.calls, 0),
    perFamily,
    model: routes.flicker.model,
    holesModel: routes.holes.model,
    estimateUsd,
    capUsd,
    withinCap: estimateUsd <= capUsd + 1e-9,
  };
}

/**
 * Runs animation QA on each strip. With a provider, the identity-flicker and holes calls of every
 * strip are reserved against the cap before the first one is made.
 */
export async function runAnimationQa(options: {
  targets: StripTarget[];
  outDir: string;
  routes: Routes;
  capUsd: number;
  provider?: { provider: GenerationProvider; name: string };
  now?: () => Date;
}): Promise<{ results: StripQaResult[]; spentUsd: number }> {
  const vision = options.provider !== undefined;
  const plan = await planAnimationQa(options.targets, options.routes, options.capUsd, vision);
  const budget = new Budget(options.capUsd);
  // Refuse up front when the whole run would not fit, before any provider call.
  budget.settle(budget.reserve(plan.estimateUsd, "the identity-flicker and holes calls"), 0);
  const call = options.provider
    ? new Caller({
        provider: options.provider.provider,
        providerName: options.provider.name,
        budget,
        routes: options.routes,
        ...(options.now !== undefined && { now: options.now }),
      })
    : undefined;
  const results: StripQaResult[] = [];
  for (const t of options.targets) {
    const { raster, origin } = await readStrip(t.path);
    results.push(
      await qaStrip({
        strip: raster,
        family: t.family,
        profile: t.profile,
        style: t.style,
        frame: t.frame,
        anchor: t.anchor,
        ...(t.durationMs !== undefined && { durationMs: t.durationMs }),
        ...(t.gait !== undefined && { gait: t.gait }),
        outDir: options.outDir,
        ...(origin !== undefined && { digitalSourceType: origin }),
        ...(call && {
          vision: {
            call,
            subject: t.subject,
            ...(options.now !== undefined && { now: options.now }),
          },
        }),
      }),
    );
  }
  return { results, spentUsd: budget.spentUsd };
}

export { DEFAULT_FIX_CAP_USD };

export function planFrameFix(routes: Routes, capUsd: number) {
  const perCall: PlannedCall[] = planFix(routes);
  const estimateUsd = perCall.reduce((s, c) => s + c.estimatedCostUsd, 0);
  return {
    calls: perCall.length,
    perCall,
    estimateUsd,
    capUsd,
    withinCap: estimateUsd <= capUsd + 1e-9,
  };
}

export interface FixFrameRun {
  stripPath: string;
  provenancePath: string;
  fix: FrameFix;
  qa: StripQaResult;
  spentUsd: number;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Fixes one frame of a strip and writes the fixed strip, its provenance and its QA and previews
 * into the output directory. Never writes into a target and never sets a review value.
 */
export async function runFixFrame(options: {
  target: StripTarget;
  index: number;
  from: { neighbour: number } | { keyPose: string };
  note?: string;
  provenancePath?: string;
  bible?: { version: string; palette: string[] };
  outDir: string;
  routes: Routes;
  capUsd: number;
  provider: { provider: GenerationProvider; name: string };
  now?: () => Date;
}): Promise<FixFrameRun> {
  const { target } = options;
  if (resolve(options.outDir, basename(target.path)) === resolve(target.path)) {
    throw new InputError(
      "--out must not be the strip's own directory; the fix never overwrites it",
    );
  }
  const style = resolveStyle(target.profile.style, options.bible?.palette);
  const { raster, origin } = await readStrip(target.path);
  const sidecar = options.provenancePath ?? `${target.path}.provenance.json`;
  let provenance: Provenance | undefined;
  if (options.provenancePath !== undefined || (await exists(sidecar))) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(sidecar, "utf8"));
    } catch (error) {
      throw new InputError(`cannot read the provenance ${sidecar}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    // Checked here, before any call: a record the fix cannot extend must cost nothing.
    provenance = fixBaseProvenance(value, {
      strip: raster,
      source: sidecar,
      license: target.profile.license,
      ...(options.bible !== undefined && { bibleVersion: options.bible.version }),
      at: (options.now ?? (() => new Date()))().toISOString(),
    });
  }
  if (provenance && origin !== undefined && provenance.digitalSourceType === undefined) {
    provenance = { ...provenance, digitalSourceType: origin };
  }
  const keyPose =
    "keyPose" in options.from
      ? await loadReference(options.from.keyPose, "approved key pose", process.cwd())
      : undefined;
  const budget = new Budget(options.capUsd);
  const call = new Caller({
    provider: options.provider.provider,
    providerName: options.provider.name,
    budget,
    routes: options.routes,
    ...(options.now !== undefined && { now: options.now }),
  });
  const fixed = await fixFrame({
    strip: raster,
    frame: target.frame,
    anchor: target.anchor,
    family: target.family,
    subject: target.subject,
    index: options.index,
    from: keyPose ? { keyPose } : (options.from as { neighbour: number }),
    style,
    call,
    ...(options.note !== undefined && { note: options.note }),
    ...(provenance !== undefined && { provenance }),
    stripPath: target.path,
    license: target.profile.license,
    ...(options.bible !== undefined && { bibleVersion: options.bible.version }),
    ...(options.now !== undefined && { now: options.now }),
  });
  await mkdir(options.outDir, { recursive: true });
  const name = basename(target.path);
  const stripPath = resolve(options.outDir, name);
  const origin2 = fixed.provenance.digitalSourceType;
  const png = encodePng(fixed.strip);
  await writeFile(
    stripPath,
    origin2 === undefined ? png : embedDigitalSourceType(png, "image/png", origin2),
  );
  const provenancePath = `${stripPath}.provenance.json`;
  await writeFile(provenancePath, `${JSON.stringify(fixed.provenance, null, 2)}\n`);
  const qa = await qaStrip({
    strip: fixed.strip,
    family: target.family,
    profile: target.profile,
    style,
    frame: target.frame,
    anchor: target.anchor,
    ...(target.durationMs !== undefined && { durationMs: target.durationMs }),
    ...(target.gait !== undefined && { gait: target.gait }),
    outDir: options.outDir,
    ...(origin2 !== undefined && { digitalSourceType: origin2 }),
  });
  return { stripPath, provenancePath, fix: fixed.fix, qa, spentUsd: budget.spentUsd };
}
