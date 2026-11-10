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
export async function validatorCheck(bytes: Uint8Array): Promise<Reason> {
  const report = await validateBytes(bytes, { format: "glb", maxIssues: 50 });
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
 * library clip) are listed and do not fail the candidate.
 */
export function clipChecks(
  glb: Glb,
  planned: ClipPlan[],
  missing: Array<{ family: string; why: string }>,
  settings: ResolvedModel3d,
  heightM: number,
): Reason[] {
  const reasons: Reason[] = [];
  const all = clips(glb);
  const joints = new Set((glb.json.skins ?? []).flatMap((s) => s.joints));
  for (const { family, loop } of planned) {
    const clip = all.find((c) => c.name === family);
    if (!clip) {
      reasons.push(
        deterministic(`clip-${family}`, false, `no clip named "${family}" in the model`),
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
      const maxTranslation = settings.loopTolerance.translationFraction * heightM;
      const closed =
        error.rotationDeg <= settings.loopTolerance.rotationDeg &&
        error.translation <= maxTranslation;
      reasons.push(
        deterministic(
          `loop-${family}`,
          closed,
          `last pose ${closed ? "returns" : "does not return"} to the first: ` +
            `${error.rotationDeg.toFixed(2)}° (tolerance ${settings.loopTolerance.rotationDeg}°), ` +
            `${error.translation.toFixed(4)} m (tolerance ${maxTranslation.toFixed(4)} m)`,
        ),
      );
    }
  }
  for (const { family, why } of missing) {
    reasons.push(deterministic(`clip-${family}`, true, `missing, not faked: ${why}`));
  }
  return reasons;
}

/** Passes when every check that filters passed; shadow-mode reasons are recorded, never filter. */
export function qaPassed(reasons: Reason[]): boolean {
  const filtering = reasons.filter((r) => !r.shadow);
  return filtering.length > 0 && filtering.every((r) => r.passed);
}
