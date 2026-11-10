/**
 * The `character-3d` generator: a rigged, animated `.glb` from a character's approved turnaround.
 * One candidate makes a 3D generation call, a rig call, one clip call for every family the
 * provider's library has, and an identity call on the rendered views; all are reserved against the
 * cap before the run's first call. QA runs before the pick and is recorded per candidate.
 */
import { InputError, ProviderError } from "../errors.ts";
import type { Generator, GeneratorContext, PlannedCall } from "../generators/generator.ts";
import { identitySettings, identityReason, scoreIdentity } from "../identity.ts";
import type { IdentityRecord, IdentityScore } from "../identity.ts";
import { createRaster, decodeImage, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { loadReference, sha256, subjectOf } from "../request.ts";
import type { Route, Routes } from "../routes.ts";
import type { AssetSpec, LoadedReference, Reason, StyleBible, TargetProfile } from "../types.ts";
import { GLB_MEDIA_TYPE, parseGlb, writeGlb } from "./glb.ts";
import type { Glb } from "./glb.ts";
import { CHARACTER_3D_KIND, FRAMES_PER_CLIP, characterSpec, model3dSettings } from "./profile.ts";
import type { CharacterSpec } from "./profile.ts";
import {
  budgetChecks,
  clipChecks,
  hierarchyCheck,
  qaPassed,
  skeletonCheck,
  validatorCheck,
} from "./qa.ts";
import type { ClipPlan } from "./qa.ts";
import { renderTurntable } from "./render.ts";
import {
  clips,
  closeLoop,
  keepClips,
  measure,
  normalize,
  renameClips,
  yawBetween,
} from "./scene.ts";

export const MODEL_OPERATION = "model3d";
export const RIG_OPERATION = "rig3d";
export const CLIPS_OPERATION = "clips3d";

/** Which requested families the clip route's library has, and which it does not. */
export function clipPlan(
  character: CharacterSpec,
  route: Route | undefined,
): {
  planned: Array<ClipPlan & { clip: string }>;
  missing: Array<{ family: string; why: string }>;
} {
  const library = route?.library?.[character.gait] ?? {};
  const planned: Array<ClipPlan & { clip: string }> = [];
  const missing: Array<{ family: string; why: string }> = [];
  for (const family of character.clips) {
    const entry = library[family];
    if (entry && typeof entry.clip === "string") {
      planned.push({ family, clip: entry.clip, loop: entry.loop === true });
    } else {
      missing.push({
        family,
        why: `the ${route?.model ?? "clip route"} library has no close ${character.gait} clip for "${family}"`,
      });
    }
  }
  return { planned, missing };
}

/** Bible references of the subject, each with the view it shows, read from its role. */
function viewOf(role: string): string {
  const r = role.toLowerCase();
  if (r.includes("three-quarter") || r.includes("3/4")) return "three-quarter";
  if (r.includes("front")) return "front";
  if (r.includes("back")) return "back";
  if (r.includes("left") || r.includes("side")) return "left";
  if (r.includes("right")) return "right";
  return role;
}

async function subjectReferences(
  spec: AssetSpec,
  bible: StyleBible,
  bibleDir: string,
): Promise<Array<LoadedReference & { view: string }>> {
  const subject = subjectOf(spec);
  const refs = bible.references.filter((r) => r.subject === subject && r.role !== "perspective");
  if (refs.length === 0) {
    throw new InputError(`the style bible has no approved references for subject "${subject}"`);
  }
  const loaded = await Promise.all(refs.map((r) => loadReference(r.path, r.role, bibleDir)));
  return loaded.map((r) => ({ ...r, view: viewOf(r.role) }));
}

/**
 * The identity record of a 3D character: the bible's approved references of the subject, with its
 * description as the signature features and the bible palette. Versioned with the bible.
 */
export function identityRecordOf(
  spec: AssetSpec,
  bible: StyleBible,
  references: LoadedReference[],
): IdentityRecord {
  const subject = subjectOf(spec);
  const description = bible.subjects?.[subject]?.description ?? subject;
  const fingerprint = {
    signatureFeatures: [description],
    proportions: description,
    palette: bible.palette,
  };
  const refs = references.map((r) => ({ role: r.role, path: r.path, sha256: r.sha256 }));
  return {
    subject,
    version: bible.version,
    sha256: sha256(Buffer.from(JSON.stringify({ fingerprint, refs }))),
    fingerprint,
    references: refs,
  };
}

function sideBySide(images: Raster[]): Raster {
  const height = Math.max(...images.map((r) => r.height));
  const width = images.reduce((sum, r) => sum + r.width, 0);
  const out = createRaster(width, height);
  let x0 = 0;
  for (const image of images) {
    for (let y = 0; y < image.height; y++) {
      out.data.set(
        image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
        (y * width + x0) * 4,
      );
    }
    x0 += image.width;
  }
  return out;
}

function prompt(spec: AssetSpec, bible: StyleBible, character: CharacterSpec): string {
  const subject = subjectOf(spec);
  const description = bible.subjects?.[subject]?.description;
  return [
    `A real-time 3D game character for the style bible version ${bible.version}.`,
    description ? `Subject: ${subject}, ${description}.` : `Subject: ${subject}.`,
    `Gait: ${character.gait}. Match the approved turnaround views exactly.`,
    ...(bible.mood?.length ? [`Mood: ${bible.mood.join(", ")}.`] : []),
  ].join("\n");
}

/** Maps the provider's returned animations to the planned families, in request order. */
function matchClips(glb: Glb, planned: Array<ClipPlan & { clip: string }>) {
  const available = clips(glb);
  const matched = new Map<number, string>();
  const unmatched: Array<{ family: string; why: string }> = [];
  planned.forEach((p, i) => {
    let index: number | undefined;
    if (available.length === planned.length) index = available[i]?.index;
    else {
      const tail = p.clip.split(":").at(-1) ?? p.clip;
      index = available.find(
        (a) => !matched.has(a.index) && a.name.toLowerCase().includes(tail.toLowerCase()),
      )?.index;
      if (index === undefined && planned.length === 1) index = available[0]?.index;
    }
    if (index === undefined || matched.has(index)) {
      unmatched.push({
        family: p.family,
        why: `the provider returned no animation for library clip ${p.clip}`,
      });
    } else matched.set(index, p.family);
  });
  return { matched, unmatched };
}

export const character3dGenerator: Generator = {
  kind: CHARACTER_3D_KIND,

  planCandidate(spec: AssetSpec, profile: TargetProfile, routes: Routes): PlannedCall[] {
    const character = characterSpec(spec);
    model3dSettings(profile);
    const calls: PlannedCall[] = [];
    const add = (operation: string) => {
      const route = routes[operation];
      if (!route) throw new InputError(`no model route for operation "${operation}"`);
      calls.push({ operation, model: route.model, estimatedCostUsd: route.estimatedCostUsd });
    };
    add(MODEL_OPERATION);
    add(RIG_OPERATION);
    if (clipPlan(character, routes[CLIPS_OPERATION]).planned.length > 0) add(CLIPS_OPERATION);
    if (identitySettings(profile).mode !== "off") add("identity");
    return calls;
  },

  async generate(context: GeneratorContext) {
    const { spec, bible, profile, call } = context;
    const character = characterSpec(spec);
    const settings = model3dSettings(profile);
    const references = await subjectReferences(spec, bible, context.bibleDir);
    const text = prompt(spec, bible, character);

    const made = await call.model3d(
      MODEL_OPERATION,
      text,
      references,
      context.seed,
      settings.budgets.triangles,
    );
    const rigRoute = call.route(RIG_OPERATION);
    const rigType = rigRoute.rigTypes?.[character.gait] ?? character.gait;
    const rigged = await call.rig3d(RIG_OPERATION, made.handle, rigType);
    const plan = clipPlan(character, call.route(CLIPS_OPERATION));
    let source = rigged;
    if (plan.planned.length > 0) {
      source = await call.clips3d(
        CLIPS_OPERATION,
        rigged.handle,
        plan.planned.map((p) => p.clip),
      );
    }

    let glb: Glb;
    try {
      glb = parseGlb(source.glb);
    } catch (error) {
      throw new ProviderError(`the provider returned no usable glTF: ${(error as Error).message}`);
    }
    const { matched, unmatched } = matchClips(glb, plan.planned);
    keepClips(glb, [...matched.keys()]);
    renameClips(glb, new Map([...matched.values()].map((family, i) => [i, family])));
    const delivered = plan.planned.filter((p) => [...matched.values()].includes(p.family));
    // Only families the library has no close clip for are excused; a library clip that was
    // requested but not returned fails its clip check.
    const missing = plan.missing;
    const closed: Record<string, number> = {};
    delivered.forEach((p, i) => {
      if (p.loop) closed[p.family] = closeLoop(glb, i);
    });
    const bounds = normalize(glb, {
      sourceForward: call.route(MODEL_OPERATION).forward ?? "+z",
      forward: settings.forward,
      ...(character.heightM !== undefined && { heightM: character.heightM }),
    });
    const bytes = writeGlb(glb);
    const written = parseGlb(bytes);
    const measures = measure(written);
    const height = bounds.max[1] - bounds.min[1];

    const reasons: Reason[] = [
      await validatorCheck(bytes),
      hierarchyCheck(written, measures),
      ...budgetChecks(measures, settings),
      skeletonCheck(measures),
      ...clipChecks(written, plan.planned, missing, settings, height, unmatched),
    ];

    const renders = renderTurntable(written, {
      sizePx: settings.turntablePx,
      framesPerClip: FRAMES_PER_CLIP,
      forwardYawDeg: (yawBetween("+z", settings.forward) * 180) / Math.PI,
    });
    reasons.push({
      check: "turntable",
      passed: renders.length >= 4,
      reason: `${renders.length} render(s) from a fixed camera and light: ${renders.map((r) => r.name).join(", ")}`,
      source: "deterministic",
    });

    let identity: IdentityScore | undefined;
    const identityMode = identitySettings(profile);
    if (identityMode.mode !== "off") {
      const views = ["front", "three-quarter"].map((name) => {
        const render = renders.find((r) => r.view === name && r.clip === undefined);
        if (!render) throw new Error(`no ${name} render`);
        return decodeImage(render.png);
      });
      const composite = encodePng(sideBySide(views));
      identity = await scoreIdentity({
        caller: call,
        record: identityRecordOf(spec, bible, references),
        references,
        candidate: {
          role: "candidate turntable",
          path: "(front and three-quarter renders)",
          mediaType: "image/png",
          bytes: composite,
          sha256: sha256(composite),
        },
        describe:
          "turntable renders of a 3D character model, front view on the left and three-quarter view on the right",
        settings: identityMode,
      });
      reasons.push(identityReason(identity));
    }

    const clipFields = clips(written).map((c) => ({
      name: c.name,
      durationMs: Math.round(c.durationS * 1000),
      loop: delivered.find((p) => p.family === c.name)?.loop ?? false,
    }));
    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    return {
      output: {
        mediaType: GLB_MEDIA_TYPE,
        extension: "glb",
        bytes,
        fields: {
          triangles: measures.triangles,
          textureMaxPx: measures.textureMaxPx,
          materials: measures.materials,
          bones: measures.bones,
          lods: measures.lods,
          clips: clipFields,
          bounds: { min: bounds.min.map(round), max: bounds.max.map(round) },
          gait: character.gait,
          missingClips: missing,
          ...(unmatched.length > 0 && { unmatchedClips: unmatched }),
          ...(identity && { identity }),
        },
      },
      qa: { passed: qaPassed(reasons), reasons },
      prompt: text,
      parameters: {
        gait: character.gait,
        rigType,
        clips: plan.planned.map((p) => ({ family: p.family, clip: p.clip, loop: p.loop })),
        missingClips: missing,
        ...(unmatched.length > 0 && { unmatchedClips: unmatched }),
        loopClosedChannels: closed,
        forward: settings.forward,
        ...(character.heightM !== undefined && { heightM: character.heightM }),
        references: references.map((r) => ({
          role: r.role,
          view: r.view,
          path: r.path,
          sha256: r.sha256,
        })),
      },
      artifacts: renders.map((r) => ({ name: r.name, bytes: r.png })),
    };
  },
};
