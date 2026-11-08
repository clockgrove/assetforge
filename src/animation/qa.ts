/**
 * Deterministic pixel animation QA of one strip: frame count, timing and beats against the
 * family's motion template, ground contact, anchor and footprint drift, silhouette change
 * between frames and the loop seam. Every check adds a reason whether it passes or not, and each
 * failing reason names the frame(s) in 1-based numbers.
 */
import type { Raster } from "../image/raster.ts";
import type { ResolvedStyle } from "../style.ts";
import type { Point, TargetProfile } from "../types.ts";
import { templateFor, templatesFor, thresholdsFor } from "./templates.ts";
import { measureThreshold } from "./strip.ts";
import type {
  AnimationFrameMeasure,
  AnimationReason,
  AnimationReport,
  AnimationThresholds,
  MotionTemplate,
  StripInput,
} from "./types.ts";

const alphaAt = (r: Raster, i: number): number => r.data[i * 4 + 3] as number;

/** Baseline, alpha-weighted centre of mass, area and footprint of every frame. */
export function measureStrip(
  frames: Raster[],
  anchor: Point,
  threshold: number,
): AnimationFrameMeasure[] {
  void anchor;
  return frames.map((r, k) => {
    let baseline = -1;
    let sum = 0;
    let sx = 0;
    let sy = 0;
    let area = 0;
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        const a = alphaAt(r, y * r.width + x);
        if (a === 0) continue;
        sum += a;
        sx += a * (x + 0.5);
        sy += a * (y + 0.5);
        if (a >= threshold) {
          baseline = y;
          area++;
        }
      }
    }
    const measure: AnimationFrameMeasure = {
      frame: k + 1,
      baseline,
      centerX: sum > 0 ? sx / sum : 0,
      centerY: sum > 0 ? sy / sum : 0,
      area,
    };
    if (baseline >= 0) {
      let left = Number.POSITIVE_INFINITY;
      let right = -1;
      for (let y = Math.max(0, baseline - 1); y <= baseline; y++) {
        for (let x = 0; x < r.width; x++) {
          if (alphaAt(r, y * r.width + x) >= threshold) {
            left = Math.min(left, x);
            right = Math.max(right, x);
          }
        }
      }
      if (right >= 0) measure.footprint = [left, right];
    }
    return measure;
  });
}

/** 1 − IoU of the two alpha masks; 0 when both are empty. */
export function silhouetteChange(a: Raster, b: Raster, threshold: number): number {
  let both = 0;
  let either = 0;
  const n = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < n; i++) {
    const ina = alphaAt(a, i) >= threshold;
    const inb = alphaAt(b, i) >= threshold;
    if (ina || inb) either++;
    if (ina && inb) both++;
  }
  return either === 0 ? 0 : 1 - both / either;
}

/** Mean of the silhouette change and the mean RGB difference over the union of the masks. */
export function frameDistance(a: Raster, b: Raster, threshold: number): number {
  let diff = 0;
  let union = 0;
  const n = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < n; i++) {
    if (alphaAt(a, i) < threshold && alphaAt(b, i) < threshold) continue;
    union++;
    for (let c = 0; c < 3; c++) {
      diff += Math.abs((a.data[i * 4 + c] as number) - (b.data[i * 4 + c] as number)) / 255;
    }
  }
  const colour = union === 0 ? 0 : diff / (union * 3);
  return (silhouetteChange(a, b, threshold) + colour) / 2;
}

const DEFAULT_SILHOUETTE = { min: 0, max: 0.5 };
const fix = (n: number) => Number(n.toFixed(2));

export function checkAnimation(
  input: StripInput,
  options: { template?: MotionTemplate; thresholds: AnimationThresholds; threshold: number },
): AnimationReport {
  const { template, thresholds, threshold } = options;
  const { frames, anchor, family } = input;
  const count = frames.length;
  const measures = measureStrip(frames, anchor, threshold);
  const reasons: AnimationReason[] = [];
  const add = (check: string, passed: boolean, reason: string, at?: number[]) =>
    reasons.push({
      check,
      passed,
      reason,
      source: "deterministic",
      ...(at !== undefined && { frames: at }),
    });

  const loop = template ? template.loop : true;
  const silhouette = template?.silhouette ?? DEFAULT_SILHOUETTE;

  if (!template) {
    add(
      "template",
      true,
      `no motion template matches family ${family}; loop and continuity checks use the defaults`,
    );
  } else {
    const { min, max } = template.frames;
    const ok = count >= min && count <= max;
    add(
      "template",
      ok,
      ok
        ? `${count} frames is within the ${template.name} template's ${min}..${max}`
        : `${count} frames is outside the ${template.name} template's ${min}..${max}`,
    );
    if (input.durationMs !== undefined && template.cycleMs) {
      const cycle = count * input.durationMs;
      const { min: lo, max: hi } = template.cycleMs;
      const inRange = cycle >= lo && cycle <= hi;
      add(
        "timing",
        inRange,
        `${count} frames × ${input.durationMs} ms = ${cycle} ms cycle ${inRange ? "is within" : "is outside"} the ${template.name} template's ${lo}..${hi} ms`,
      );
    }
    const beats = template.beats;
    if (count < beats.length) {
      add("beats", false, `${count} frames cannot hold ${beats.length} beats of ${template.name}`);
    } else {
      const map = beats.map((b) => ({ b, frame: (Math.round(b.at * count) % count) + 1 }));
      add(
        "beats",
        true,
        `beats fall on ${map.map((m) => `${m.b.name} → frame ${m.frame}`).join(", ")}`,
        map.map((m) => m.frame),
      );
    }
  }

  const beatFrames = template
    ? template.beats.map((b) => ({
        contact: b.contact === true,
        frame: (Math.round(b.at * count) % count) + 1,
      }))
    : [];
  const mustTouch = new Set<number>();
  if (!template || template.contact === "all") {
    for (let f = 1; f <= count; f++) mustTouch.add(f);
  } else if (template.contact === "beats") {
    for (const b of beatFrames) if (b.contact && b.frame <= count) mustTouch.add(b.frame);
  }

  // ground-contact
  const groundFails = [...mustTouch]
    .sort((a, b) => a - b)
    .flatMap((f) => {
      const m = measures[f - 1] as AnimationFrameMeasure;
      if (m.baseline < 0)
        return [{ f, text: `frame ${f}: empty, no pixel to rest on the ground line ${anchor.y}` }];
      const off = Math.abs(m.baseline - anchor.y);
      if (off <= thresholds.groundTolerancePx) return [];
      const dir = m.baseline < anchor.y ? "above" : "below";
      return [
        {
          f,
          text: `frame ${f}: baseline at row ${m.baseline}, ${off} px ${dir} the ground line ${anchor.y} (limit ${thresholds.groundTolerancePx})`,
        },
      ];
    });
  if (groundFails.length === 0) {
    add(
      "ground-contact",
      true,
      mustTouch.size === 0
        ? `${template?.name ?? family} has no contact frames to check`
        : `frames ${[...mustTouch].join(", ")} rest on the ground line ${anchor.y}`,
    );
  }
  for (const g of groundFails) add("ground-contact", false, g.text, [g.f]);

  // anchor-drift
  const driftFails = measures.filter(
    (m) => m.baseline < 0 || Math.abs(m.centerX - (anchor.x + 0.5)) > thresholds.anchorDriftPx,
  );
  if (driftFails.length === 0) {
    add(
      "anchor-drift",
      true,
      `every frame's centre of mass is within ${thresholds.anchorDriftPx} px of the anchor`,
    );
  }
  for (const m of driftFails) {
    add(
      "anchor-drift",
      false,
      m.baseline < 0
        ? `frame ${m.frame}: empty, no centre of mass`
        : `frame ${m.frame}: centre of mass x ${fix(m.centerX)} is ${fix(Math.abs(m.centerX - (anchor.x + 0.5)))} px from the anchor ${anchor.x + 0.5} (limit ${thresholds.anchorDriftPx})`,
      [m.frame],
    );
  }

  // footprint-drift
  const limit = template?.footprintDriftPx ?? thresholds.footprintDriftPx;
  const planted = measures.filter(
    (m) => m.footprint && Math.abs(m.baseline - anchor.y) <= thresholds.groundTolerancePx,
  );
  const centre = (m: AnimationFrameMeasure) =>
    ((m.footprint as [number, number])[0] + (m.footprint as [number, number])[1] + 1) / 2;
  if (template?.footprint === "moving") {
    // The contacts move by design, so a frame is held to its own phase: with two or more strides
    // per cycle, the same frame one stride earlier (frame f against f − count/strides); with one,
    // the loop's mean footprint. Each frame that strays fails on its own, so the author can see
    // which frame slid.
    const strides = template.strides ?? 1;
    const byFrame = new Map(planted.map((m) => [m.frame, m]));
    const stride = count / strides;
    const fails: Array<{ f: number; text: string }> = [];
    let basis: string;
    if (strides >= 2 && stride >= 1) {
      basis = `its phase one stride (${fix(stride)} frames) earlier`;
      let compared = 0;
      for (const m of planted) {
        const s = Math.floor((m.frame - 1) / stride);
        if (s === 0) continue;
        const ref = byFrame.get(m.frame - Math.round(s * stride));
        if (!ref) continue;
        compared++;
        const d = Math.abs(centre(m) - centre(ref));
        if (d > limit) {
          fails.push({
            f: m.frame,
            text: `frame ${m.frame}: footprint centre ${fix(centre(m))} is ${fix(d)} px from frame ${ref.frame}'s ${fix(centre(ref))}, the same phase one stride earlier (limit ${limit})`,
          });
        }
      }
      if (compared === 0) basis = "";
    } else {
      const mean = planted.reduce((t, m) => t + centre(m), 0) / Math.max(1, planted.length);
      basis = planted.length < 2 ? "" : `the loop's mean footprint centre ${fix(mean)}`;
      if (basis) {
        for (const m of planted) {
          const d = Math.abs(centre(m) - mean);
          if (d > limit) {
            fails.push({
              f: m.frame,
              text: `frame ${m.frame}: footprint centre ${fix(centre(m))} is ${fix(d)} px from the loop's mean footprint centre ${fix(mean)} (limit ${limit})`,
            });
          }
        }
      }
    }
    if (fails.length === 0) {
      add(
        "footprint-drift",
        true,
        basis
          ? `the ${template.name} template's contacts move; every planted frame's footprint is within ${limit} px of ${basis}`
          : `the ${template.name} template's contacts move; no two planted frames share a phase, footprint drift not applicable`,
      );
    }
    for (const x of fails) add("footprint-drift", false, x.text, [x.f]);
  } else {
    const first = planted[0];
    const footFails = first
      ? planted.filter((m) => Math.abs(centre(m) - centre(first)) > limit)
      : [];
    if (footFails.length === 0) {
      add(
        "footprint-drift",
        true,
        first
          ? `footprints stay within ${limit} px of frame ${first.frame}'s`
          : "no frame rests on the ground line; footprint drift not applicable",
      );
    }
    for (const m of footFails) {
      add(
        "footprint-drift",
        false,
        `frame ${m.frame}: footprint centre ${fix(centre(m))} is ${fix(Math.abs(centre(m) - centre(first as AnimationFrameMeasure)))} px from frame ${(first as AnimationFrameMeasure).frame}'s ${fix(centre(first as AnimationFrameMeasure))} (limit ${limit})`,
        [m.frame],
      );
    }
  }

  // silhouette and loop seam
  const changes: number[] = [];
  for (let i = 0; i + 1 < count; i++) {
    changes.push(silhouetteChange(frames[i] as Raster, frames[i + 1] as Raster, threshold));
  }
  const dists: number[] = [];
  for (let i = 0; i + 1 < count; i++) {
    dists.push(frameDistance(frames[i] as Raster, frames[i + 1] as Raster, threshold));
  }
  let seamChange: number | undefined;
  if (count > 1 && loop) {
    seamChange = silhouetteChange(frames[count - 1] as Raster, frames[0] as Raster, threshold);
  }
  if (count < 2) {
    add("silhouette", true, "a single frame has no silhouette change to check (not applicable)");
    add("loop-seam", true, "a single frame has no loop seam (not applicable)");
  } else {
    const pairs = changes.map((c, i) => ({ c, a: i + 1, b: i + 2 }));
    if (seamChange !== undefined) pairs.push({ c: seamChange, a: count, b: 1 });
    const bad = pairs.filter((p) => p.c < silhouette.min || p.c > silhouette.max);
    if (bad.length === 0) {
      add(
        "silhouette",
        true,
        `silhouette change stays within ${silhouette.min}..${silhouette.max} between every pair of frames`,
      );
    }
    for (const p of bad) {
      add(
        "silhouette",
        false,
        `frame ${p.a} → frame ${p.b}: silhouette change ${fix(p.c)} is outside ${silhouette.min}..${silhouette.max}`,
        [p.a, p.b],
      );
    }
    if (!loop) {
      add("loop-seam", true, `the ${template?.name} template does not loop; no seam to check`);
    } else {
      const seam = frameDistance(frames[count - 1] as Raster, frames[0] as Raster, threshold);
      const bound = thresholds.loopSeamRatio * Math.max(thresholds.loopSeamFloor, ...dists);
      const ok = seam <= bound;
      add(
        "loop-seam",
        ok,
        ok
          ? `frame ${count} → frame 1 distance ${fix(seam)} is within ${thresholds.loopSeamRatio} × the largest step, floor ${thresholds.loopSeamFloor} (${fix(bound)})`
          : `frame ${count} → frame 1: distance ${fix(seam)} exceeds ${thresholds.loopSeamRatio} × the largest consecutive step, floor ${thresholds.loopSeamFloor} (limit ${fix(bound)})`,
        [count, 1],
      );
    }
  }

  return {
    family,
    ...(template && { template: template.name }),
    frameCount: count,
    passed: reasons.every((r) => r.passed),
    reasons,
    measures,
    silhouetteChange: seamChange === undefined ? changes : [...changes, seamChange],
    thresholds,
  };
}

/** The strip checked against the profile's templates and thresholds and the style's alpha cut. */
export function animationQa(
  input: StripInput,
  profile: Pick<TargetProfile, "animation">,
  style: ResolvedStyle,
): AnimationReport {
  return checkAnimation(input, {
    template: templateFor(input.family, templatesFor(profile)),
    thresholds: thresholdsFor(profile),
    threshold: measureThreshold(style),
  });
}
