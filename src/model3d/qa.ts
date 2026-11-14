/**
 * QA of a 3D character candidate, all before the pick: the Khronos glTF validator, the target's
 * budgets, the skeleton and its clips, and loop closure. Each check is one reason.
 */
import { validateBytes, version as validatorVersion } from "gltf-validator";
import type { Reason } from "../types.ts";
import type { Glb } from "./glb.ts";
import { BUDGET_KEYS } from "./profile.ts";
import type { ResolvedModel3d } from "./profile.ts";
import { clips, loopError, samplePose } from "./scene.ts";
import type { Measures } from "./scene.ts";

const deterministic = (check: string, passed: boolean, reason: string): Reason => ({
  check,
  passed,
  reason,
  source: "deterministic",
});

/** The Khronos glTF validator's verdict: no errors passes; warnings are listed, not failed. */
export async function validatorCheck(
  bytes: Uint8Array,
  resources?: Record<string, Uint8Array>,
): Promise<Reason> {
  const report = await validateBytes(bytes, {
    format: "glb",
    maxIssues: 50,
    ...(resources && {
      externalResourceFunction: (uri: string) => {
        const found = resources[decodeURIComponent(uri)];
        return found
          ? Promise.resolve(found)
          : Promise.reject(new Error(`external resource ${uri} was not provided`));
      },
    }),
  });
  const { numErrors, numWarnings, messages } = report.issues;
  const errors = messages.filter((m) => m.severity === 0).slice(0, 5);
  const detail = errors.map((m) => `${m.code} at ${m.pointer ?? "?"}: ${m.message}`).join("; ");
  return deterministic(
    "gltf-validator",
    numErrors === 0,
    `Khronos glTF validator ${validatorVersion()}: ${numErrors} error(s), ${numWarnings} warning(s)` +
      (detail ? `: ${detail}` : ""),
  );
}

/** One reason per budget: over budget fails with the measured value. */
export function budgetChecks(measures: Measures, settings: ResolvedModel3d): Reason[] {
  return BUDGET_KEYS.map((key) => {
    const measured = measures[key];
    const budget = settings.budgets[key];
    if (key === "textureMaxPx" && measures.unmeasuredImages.length > 0) {
      return deterministic(
        `budget-${key}`,
        false,
        `${key} not measured: the size of image(s) ${measures.unmeasuredImages.join(", ")} cannot be read ` +
          `(an external uri or an unknown format), so the budget of ${budget} cannot be checked`,
      );
    }
    const within = measured <= budget;
    return deterministic(
      `budget-${key}`,
      within,
      within
        ? `${key} ${measured} within ${budget}`
        : `${key} ${measured} over the budget of ${budget}`,
    );
  });
}

export function hierarchyCheck(glb: Glb, measures: Measures): Reason {
  const roots = glb.json.scenes?.[glb.json.scene ?? 0]?.nodes?.length ?? 0;
  const passed = roots === 1 && measures.meshes > 0 && measures.triangles > 0;
  return deterministic(
    "mesh-hierarchy",
    passed,
    `${roots} scene root(s), ${measures.meshes} mesh(es), ${measures.triangles} triangles`,
  );
}

export function skeletonCheck(measures: Measures): Reason {
  const passed = measures.skins > 0 && measures.bones > 0;
  return deterministic(
    "skeleton",
    passed,
    passed
      ? `${measures.skins} skin(s), ${measures.bones} bone(s)`
      : "no skeleton: the model has no skin with joints",
  );
}

export interface ClipPlan {
  family: string;
  loop: boolean;
}

/**
 * Whether every requested clip that the library had plays on the skeleton: it exists by name,
 * lasts longer than zero, animates joints of the skin, and samples. Missing families (no close
 * library clip) are listed and do not fail the candidate; a planned family the provider did not
 * return (`unmatched`) fails it.
 */
export function clipChecks(
  glb: Glb,
  planned: ClipPlan[],
  missing: Array<{ family: string; why: string }>,
  settings: ResolvedModel3d,
  heightM: number,
  unmatched: Array<{ family: string; why: string }> = [],
): Reason[] {
  const reasons: Reason[] = [];
  const all = clips(glb);
  const joints = new Set((glb.json.skins ?? []).flatMap((s) => s.joints));
  for (const { family, loop } of planned) {
    const clip = all.find((c) => c.name === family);
    if (!clip) {
      const why = unmatched.find((u) => u.family === family)?.why;
      reasons.push(
        deterministic(
          `clip-${family}`,
          false,
          `no clip named "${family}" in the model${why ? `: ${why}` : ""}`,
        ),
      );
      continue;
    }
    const animation = glb.json.animations?.[clip.index];
    const targets = new Set(animation?.channels.map((c) => c.target.node) ?? []);
    const onSkeleton = [...targets].filter((n) => n !== undefined && joints.has(n)).length;
    let samples = true;
    try {
      for (const t of [0, clip.durationS / 2, clip.durationS]) samplePose(glb, clip.index, t);
    } catch {
      samples = false;
    }
    const plays = clip.durationS > 0 && onSkeleton > 0 && samples;
    reasons.push(
      deterministic(
        `clip-${family}`,
        plays,
        plays
          ? `"${family}" plays on the skeleton: ${(clip.durationS * 1000).toFixed(0)} ms, ${onSkeleton} joint(s) animated`
          : `"${family}" does not play on the skeleton (${(clip.durationS * 1000).toFixed(0)} ms, ${onSkeleton} joint(s) animated${samples ? "" : ", sampling failed"})`,
      ),
    );
    if (plays && loop) {
      const error = loopError(glb, clip.index);
      // Joint translations are in the joints' local units, under the root's scale; heightM is in
      // metres after that scale, so bring the error into metres before comparing.
      const translationM = error.translation * rootScale(glb);
      const maxTranslation = settings.loopTolerance.translationFraction * heightM;
      const closed =
        error.rotationDeg <= settings.loopTolerance.rotationDeg && translationM <= maxTranslation;
      reasons.push(
        deterministic(
          `loop-${family}`,
          closed,
          `last pose ${closed ? "returns" : "does not return"} to the first: ` +
            `${error.rotationDeg.toFixed(2)}° (tolerance ${settings.loopTolerance.rotationDeg}°), ` +
            `${translationM.toFixed(4)} m (tolerance ${maxTranslation.toFixed(4)} m)`,
        ),
      );
    }
  }
  for (const { family, why } of missing) {
    reasons.push(deterministic(`clip-${family}`, true, `missing, not faked: ${why}`));
  }
  return reasons;
}

/** The uniform scale of the single scene root (normalize's `assetgrove-root`), 1 when none. */
function rootScale(glb: Glb): number {
  const roots = glb.json.scenes?.[glb.json.scene ?? 0]?.nodes ?? [];
  if (roots.length !== 1) return 1;
  return glb.json.nodes?.[roots[0]!]?.scale?.[0] ?? 1;
}

/** Passes when every check that filters passed; shadow-mode reasons are recorded, never filter. */
export function qaPassed(reasons: Reason[]): boolean {
  const filtering = reasons.filter((r) => !r.shadow);
  return filtering.length > 0 && filtering.every((r) => r.passed);
}
