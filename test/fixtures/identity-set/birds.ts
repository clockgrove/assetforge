import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BIBLE_PRESETS, serializeBible, type ArtBible } from "../../../src/bible.ts";
import {
  createRaster,
  encodePng,
  parseHex,
  setPixel,
  type Raster,
} from "../../../src/image/raster.ts";

/** One identity-eval case as the case file spells it; image and bible paths are relative to the file. */
export interface EvalCaseJson {
  image: string;
  subject: string;
  same: boolean;
  kind?: "same" | "drift" | "generic" | "lookalike";
  cast?: string;
  medium?: string;
  bible?: string;
  describe?: string;
  note?: string;
  /** Set on cases scored against a record whose text contradicts its own references. */
  conflict?: boolean;
  /** The Objective that added the case after the prompt it measures was written. */
  heldOut?: string;
}

export type BellyShape = "round" | "heart" | "stripe";

/** What makes a pebble bird this bird; every bird shares body shape, size and body colour. */
export interface BirdParams {
  crest: number;
  wing: string;
  belly: BellyShape;
  eyeRing: boolean;
  beak: string;
  /** Body stretch [wide, tall]; [1, 1] is the canonical proportion. */
  stretch: [number, number];
}

export interface BirdView {
  tilt: number;
  wingUp: boolean;
  facing: "left" | "right";
  scale: number;
  dx: number;
  dy: number;
  bg: string;
  /** Animation poses; none of them changes a feature the record names. */
  wingsSpread?: boolean;
  headTurned?: boolean;
  /** Radians the crest feathers are swept back about their bases. */
  crestSwept?: number;
}

const BODY = "#d8c3a5";
const CREST = "#8a7a62";
const BELLY = "#fff3d6";
const CANVAS = 256;

export const BIRDS: Record<string, BirdParams> = {
  pebble: {
    crest: 1,
    wing: "#3b6fd1",
    belly: "round",
    eyeRing: true,
    beak: "#f08a24",
    stretch: [1, 1],
  },
  dusk: {
    crest: 2,
    wing: "#c8323c",
    belly: "heart",
    eyeRing: false,
    beak: "#f2cf3a",
    stretch: [1, 1],
  },
  fern: {
    crest: 3,
    wing: "#3f9d58",
    belly: "stripe",
    eyeRing: true,
    beak: "#3a3030",
    stretch: [1, 1],
  },
};

const SIGNATURES: Record<string, string[]> = {
  pebble: [
    "one crest feather",
    "blue wings",
    "round cream belly patch",
    "white ring around the eye",
    "orange beak",
  ],
  dusk: [
    "two crest feathers",
    "red wings",
    "heart-shaped cream belly patch",
    "no eye ring",
    "yellow beak",
  ],
  fern: [
    "three crest feathers",
    "green wings",
    "vertical cream belly stripe",
    "white ring around the eye",
    "near-black beak",
  ],
};

const PROPORTIONS = "round pebble body, about as wide as tall, small head merged into the body";

const CANONICAL_VIEW: BirdView = {
  tilt: 0,
  wingUp: false,
  facing: "right",
  scale: 0.9,
  dx: 0,
  dy: 0,
  bg: "#f4f1ea",
};
const SECOND_VIEW: BirdView = {
  tilt: -0.15,
  wingUp: true,
  facing: "left",
  scale: 0.85,
  dx: 6,
  dy: -4,
  bg: "#e6eef5",
};

const POSES: { name: string; view: BirdView }[] = [
  {
    name: "flap",
    view: { ...CANONICAL_VIEW, tilt: -0.1, scale: 0.8, wingsSpread: true, bg: "#e8f0e4" },
  },
  { name: "peck", view: { ...CANONICAL_VIEW, tilt: 0.7, scale: 0.8, bg: "#f5e9dc" } },
  {
    name: "look-back",
    view: { ...CANONICAL_VIEW, tilt: -0.1, headTurned: true, bg: "#efe6f0" },
  },
  { name: "crest-swept", view: { ...CANONICAL_VIEW, tilt: 0.1, crestSwept: 0.6, bg: "#dfe6ea" } },
];

/** Run 7's held-out poses (#104), added after the prompt was frozen on run 6. */
const POSES_RUN_7: { name: string; view: BirdView }[] = [
  { name: "hop", view: { ...CANONICAL_VIEW, tilt: -0.35, wingUp: true, dy: -14, bg: "#f4f1ea" } },
  {
    name: "preen",
    view: { ...CANONICAL_VIEW, tilt: 0.45, headTurned: true, scale: 0.85, bg: "#e6eef5" },
  },
  {
    name: "glide",
    view: { ...CANONICAL_VIEW, tilt: 0.25, wingsSpread: true, scale: 0.75, bg: "#efe6f0" },
  },
  {
    name: "turn",
    view: { ...CANONICAL_VIEW, facing: "left", crestSwept: 0.4, scale: 0.85, bg: "#e8f0e4" },
  },
];

/**
 * A held-out pose; `defect` names a drawing fault of the pose itself, which makes its on-model frame
 * drift by construction (as a crop's `defect` does).
 */
interface HeldOutPose {
  name: string;
  view: BirdView;
  defect?: string;
}

/** Run 8's held-out poses (#108), added after the prompt was frozen on run 7. */
const POSES_RUN_8: HeldOutPose[] = [
  {
    name: "scratch",
    view: {
      ...CANONICAL_VIEW,
      tilt: -0.55,
      headTurned: true,
      wingUp: true,
      scale: 0.85,
      bg: "#f5e9dc",
    },
    // Found after run 8 scored it: drawBird puts a turned head's eye where a raised wing lies.
    defect:
      "the eye is drawn inside the raised wing (a turned head with the wing up), so a marking is moved",
  },
  { name: "bow", view: { ...CANONICAL_VIEW, tilt: 0.9, scale: 0.78, bg: "#dfe6ea" } },
  {
    name: "reach",
    view: {
      ...CANONICAL_VIEW,
      tilt: -0.2,
      wingsSpread: true,
      dy: -12,
      crestSwept: 0.3,
      bg: "#e6eef5",
    },
  },
  {
    name: "tuck",
    view: {
      ...CANONICAL_VIEW,
      tilt: 0.35,
      headTurned: true,
      crestSwept: 0.8,
      scale: 0.8,
      facing: "left",
      bg: "#f4f1ea",
    },
  },
  {
    name: "land",
    view: {
      ...CANONICAL_VIEW,
      tilt: -0.5,
      wingsSpread: true,
      facing: "left",
      scale: 0.8,
      bg: "#efe6f0",
    },
  },
];

/** Run 9's held-out poses (#108), added after run 8 with the prompt unchanged; none has a defect. */
const POSES_RUN_9: HeldOutPose[] = [
  {
    name: "shake",
    view: {
      ...CANONICAL_VIEW,
      tilt: 0.2,
      wingUp: true,
      crestSwept: -0.4,
      scale: 0.85,
      bg: "#e8f0e4",
    },
  },
  { name: "lean", view: { ...CANONICAL_VIEW, tilt: -0.3, scale: 0.9, dx: 10, bg: "#f5e9dc" } },
  {
    name: "glance",
    view: {
      ...CANONICAL_VIEW,
      facing: "left",
      tilt: 0.15,
      headTurned: true,
      scale: 0.82,
      bg: "#dfe6ea",
    },
  },
  {
    name: "puff",
    view: { ...CANONICAL_VIEW, tilt: -0.1, scale: 0.95, crestSwept: 0.5, bg: "#efe6f0" },
  },
  {
    name: "dip",
    view: { ...CANONICAL_VIEW, tilt: 1.0, wingsSpread: true, scale: 0.8, bg: "#f4f1ea" },
  },
];

type Pt = [number, number];
const inEllipse = (u: number, v: number, cx: number, cy: number, rx: number, ry: number) =>
  ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2 <= 1;

function inPolygon(u: number, v: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inHeart(u: number, v: number, cx: number, cy: number, size: number): boolean {
  const x = (u - cx) / size;
  const y = -(v - cy) / size;
  return (x * x + y * y - 1) ** 3 - x * x * y ** 3 <= 0;
}

/** Draws one flat-vector pebble bird; every pixel is the first shape (top first) containing it. */
export function drawBird(params: BirdParams, view: BirdView): Raster {
  const raster = createRaster(CANVAS, CANVAS);
  const bg = parseHex(view.bg);
  const colours = {
    wing: parseHex(params.wing),
    beak: parseHex(params.beak),
    body: parseHex(BODY),
    crest: parseHex(CREST),
    belly: parseHex(BELLY),
  };
  const white: [number, number, number] = [255, 255, 255];
  const ink: [number, number, number] = [24, 24, 32];
  const cos = Math.cos(-view.tilt);
  const sin = Math.sin(-view.tilt);
  const wingEllipse = view.wingUp ? [-22, -8, 22, 40] : [-15, 12, 38, 22];
  const eyeU = view.headTurned ? -28 : 28;
  const beakSide = view.headTurned ? -1 : 1;
  const beak: Pt[] = [
    [60 * beakSide, -14],
    [92 * beakSide, -4],
    [60 * beakSide, 8],
  ];
  const sweep = view.crestSwept ?? 0;
  const spreadCos = Math.cos(-0.45);
  const spreadSin = Math.sin(-0.45);
  for (let y = 0; y < CANVAS; y++) {
    for (let x = 0; x < CANVAS; x++) {
      const px = (x - CANVAS / 2 - view.dx) / view.scale;
      const py = (y - CANVAS / 2 - 10 - view.dy) / view.scale;
      let u = px * cos - py * sin;
      let v = px * sin + py * cos;
      if (view.facing === "left") u = -u;
      u /= params.stretch[0];
      v /= params.stretch[1];
      const [wx, wy, wrx, wry] = wingEllipse as [number, number, number, number];
      let colour: readonly number[] = bg;
      // A raised wing reaching past the body outline, tipped back about its root.
      const su = u + 20;
      const sv = v + 10;
      const spread =
        view.wingsSpread === true &&
        inEllipse(su * spreadCos - sv * spreadSin, su * spreadSin + sv * spreadCos, -52, 0, 64, 20);
      if (inEllipse(u, v, eyeU, -20, 3.5, 3.5)) colour = ink;
      else if (params.eyeRing && inEllipse(u, v, eyeU, -20, 13, 13)) colour = white;
      else if (inPolygon(u, v, beak)) colour = colours.beak;
      else if (spread || inEllipse(u, v, wx, wy, wrx, wry)) colour = colours.wing;
      else if (
        (params.belly === "round" && inEllipse(u, v, 10, 30, 26, 26)) ||
        (params.belly === "heart" && inHeart(u, v, 10, 30, 22)) ||
        (params.belly === "stripe" && u >= 2 && u <= 18 && v >= 6 && v <= 60)
      )
        colour = colours.belly;
      else if (inEllipse(u, v, 0, 0, 70, 66)) colour = colours.body;
      else
        for (let i = 0; i < params.crest; i++) {
          const cx = (i - (params.crest - 1) / 2) * 16;
          const along = -(u - cx) * Math.sin(sweep) - (v + 56) * Math.cos(sweep);
          const across = (u - cx) * Math.cos(sweep) - (v + 56) * Math.sin(sweep);
          if (inEllipse(along, across, 20, 0, 20, 6)) colour = colours.crest;
        }
      setPixel(raster, x, y, [colour[0]!, colour[1]!, colour[2]!, 255]);
    }
  }
  return raster;
}

/** A small seeded generator (mulberry32), so every build draws the same images. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BACKGROUNDS = ["#f4f1ea", "#e6eef5", "#efe6f0", "#e8f0e4", "#f5e9dc", "#dfe6ea"];
const OTHER_WINGS = ["#8a4fc7", "#e07b9a", "#2aa5a0", "#6b6b6b", "#c8a020"];
const OTHER_BEAKS = ["#7a4fa0", "#d05050", "#3a8fc0", "#8a8a2a"];

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function randomView(rng: () => number): BirdView {
  return {
    tilt: (rng() - 0.5) * 0.5,
    wingUp: rng() < 0.5,
    facing: rng() < 0.5 ? "left" : "right",
    scale: 0.78 + rng() * 0.17,
    dx: Math.round((rng() - 0.5) * 24),
    dy: Math.round((rng() - 0.5) * 16),
    bg: pick(rng, BACKGROUNDS),
  };
}

const FEATURES = ["crest", "wing", "belly", "eyeRing", "beak"] as const;
function differences(a: BirdParams, b: BirdParams): number {
  return (
    FEATURES.filter((f) => a[f] !== b[f]).length + (a.stretch.join() !== b.stretch.join() ? 1 : 0)
  );
}

/** Random combinations of the same parts that match no cast member in at least two features. */
function genericParams(rng: () => number): BirdParams {
  for (;;) {
    const candidate: BirdParams = {
      crest: 1 + Math.floor(rng() * 4),
      wing: pick(rng, [...OTHER_WINGS, ...Object.values(BIRDS).map((b) => b.wing)]),
      belly: pick(rng, ["round", "heart", "stripe"] as const),
      eyeRing: rng() < 0.5,
      beak: pick(rng, [...OTHER_BEAKS, ...Object.values(BIRDS).map((b) => b.beak)]),
      stretch: [1, 1],
    };
    if (Object.values(BIRDS).every((bird) => differences(candidate, bird) >= 2)) return candidate;
  }
}

/** Mixes a #rrggbb colour `t` of the way toward white. */
function lighten(hex: string, t: number): string {
  return `#${parseHex(hex)
    .map((v) =>
      Math.round(v + (255 - v) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function driftVariants(name: string, rng: () => number) {
  const base = BIRDS[name]!;
  const tall = name !== "dusk";
  const otherWing = pick(rng, OTHER_WINGS);
  const crest = base.crest === 3 ? 2 : base.crest + 1;
  return [
    {
      params: { ...base, wing: otherWing },
      what: `wing colour changed from ${base.wing} to ${otherWing}`,
    },
    {
      params: { ...base, crest },
      what: `crest feather count changed from ${base.crest} to ${crest}`,
    },
    {
      params: { ...base, eyeRing: !base.eyeRing },
      what: base.eyeRing ? "eye ring removed" : "eye ring added",
    },
    {
      params: { ...base, stretch: (tall ? [1, 1.3] : [1.3, 1]) as [number, number] },
      what: `body stretched 1.3x ${tall ? "tall" : "wide"}`,
    },
  ];
}

function record(name: string, accurate: boolean, version: string, references: string[]) {
  const bird = BIRDS[name]!;
  const lie = accurate
    ? SIGNATURES[name]!
    : [
        "two crest feathers",
        "red wings",
        "heart-shaped cream belly patch",
        "no eye ring",
        "yellow beak",
      ];
  return {
    version,
    approved: true as const,
    turnaround: references[0]!,
    references: references.slice(1),
    signatureFeatures: lie,
    proportions: PROPORTIONS,
    palette: [
      BODY,
      CREST,
      BELLY,
      accurate ? bird.wing : BIRDS["dusk"]!.wing,
      accurate ? bird.beak : BIRDS["dusk"]!.beak,
    ],
  };
}

function bibleSource(
  world: string,
  names: string[],
  accurateFor: (name: string) => boolean,
  refs: Record<string, string[]>,
) {
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!) as ArtBible;
  data.world = world;
  data.identities = {};
  for (const name of names)
    data.identities[name] = record(name, accurateFor(name), `${name}-1`, refs[name]!);
  return serializeBible(
    data,
    `# ${world}\n\nFlat vector pebble birds.\n\n## Do's and Don'ts\nDo keep each bird's signature features.\n`,
  );
}

export async function buildBirdCastSet(
  outDir: string,
): Promise<{ biblePath: string; conflictBiblePath: string; cases: EvalCaseJson[] }> {
  await mkdir(outDir, { recursive: true });
  const rng = seeded(92);
  const names = Object.keys(BIRDS);
  const write = async (file: string, params: BirdParams, view: BirdView) => {
    await writeFile(join(outDir, file), encodePng(drawBird(params, view)));
    return file;
  };

  const refs: Record<string, string[]> = {};
  for (const name of names)
    refs[name] = [
      await write(`${name}-ref-turnaround.png`, BIRDS[name]!, CANONICAL_VIEW),
      await write(`${name}-ref-2.png`, BIRDS[name]!, SECOND_VIEW),
    ];

  const biblePath = join(outDir, "BIBLE.md");
  const conflictBiblePath = join(outDir, "BIBLE.conflict.md");
  await writeFile(
    biblePath,
    bibleSource("Pebble Birds (synthetic)", names, () => true, refs),
  );
  await writeFile(
    conflictBiblePath,
    bibleSource("Pebble Birds (synthetic, conflicting record)", names, (n) => n !== "fern", refs),
  );

  const cases: EvalCaseJson[] = [];
  const add = async (
    file: string,
    params: BirdParams,
    subject: string,
    kind: NonNullable<EvalCaseJson["kind"]>,
    note: string,
    extra: Partial<EvalCaseJson> = {},
    bible = "BIBLE.md",
    view?: BirdView,
  ) => {
    await write(file, params, view ?? randomView(rng));
    cases.push({
      image: file,
      subject,
      same: kind === "same",
      kind,
      cast: extra.conflict ? "pebble-birds-conflict" : "pebble-birds",
      medium: "2d",
      bible,
      note: `${note}; params=${JSON.stringify(params)}`,
      ...extra,
    });
  };
  const othersOf = (name: string) => names.filter((n) => n !== name);

  for (const name of names) {
    const bird = BIRDS[name]!;
    for (let i = 0; i < 6; i++)
      await add(
        `${name}-same-${i}.png`,
        bird,
        name,
        "same",
        `${name} redrawn in a new pose, tilt, scale and background`,
      );
    for (const [i, d] of driftVariants(name, rng).entries()) {
      if (Object.values(BIRDS).some((b) => differences(d.params, b) === 0))
        throw new Error("a drift variant equals a cast member");
      await add(`${name}-drift-${i}.png`, d.params, name, "drift", `${name} edited: ${d.what}`, {
        describe: d.what,
      });
    }
    for (let i = 0; i < 3; i++)
      await add(
        `${name}-generic-${i}.png`,
        genericParams(rng),
        name,
        "generic",
        "random combination of pebble bird parts matching no cast member",
      );
    for (let i = 0; i < 4; i++) {
      const other = othersOf(name)[i % 2]!;
      await add(
        `${name}-lookalike-${i}.png`,
        BIRDS[other]!,
        name,
        "lookalike",
        `${other}, another cast member, in a new view`,
      );
    }
  }

  const conflictNote =
    "scored against a record whose text contradicts its references (deliberate conflict)";
  const conflict = { conflict: true as const };
  for (let i = 0; i < 2; i++)
    await add(
      `conflict-same-${i}.png`,
      BIRDS["fern"]!,
      "fern",
      "same",
      `fern redrawn; ${conflictNote}`,
      conflict,
      "BIBLE.conflict.md",
    );
  for (let i = 0; i < 2; i++) {
    const other = othersOf("fern")[i]!;
    await add(
      `conflict-lookalike-${i}.png`,
      BIRDS[other]!,
      "fern",
      "lookalike",
      `${other}, another cast member; ${conflictNote}`,
      conflict,
      "BIBLE.conflict.md",
    );
  }

  // Held-out animation poses (#104): run 6's, then run 7's, each added before its run; each pose
  // has one on-model frame and one drift, the pose named in the description and the drift not.
  for (const [run, poses, shift] of [
    ["#104 run 6", POSES, 0],
    ["#104 run 7", POSES_RUN_7, 2],
  ] as const) {
    for (const name of names) {
      const bird = BIRDS[name]!;
      const drifts = driftVariants(name, rng);
      for (const [i, pose] of poses.entries()) {
        const describe = `a frame of one character's "${pose.name}" animation`;
        await add(
          `${name}-pose-${pose.name}.png`,
          bird,
          name,
          "same",
          `${name} in its "${pose.name}" animation pose (held out, ${run})`,
          { describe, heldOut: run },
          "BIBLE.md",
          pose.view,
        );
        const d = drifts[(i + shift) % drifts.length]!;
        if (Object.values(BIRDS).some((b) => differences(d.params, b) === 0))
          throw new Error("a drift variant equals a cast member");
        await add(
          `${name}-pose-drift-${pose.name}.png`,
          d.params,
          name,
          "drift",
          `${name} in its "${pose.name}" animation pose, edited: ${d.what} (held out, ${run})`,
          { describe, heldOut: run },
          "BIBLE.md",
          pose.view,
        );
      }
    }
  }

  // Runs 8 and 9 (#108): each pose has one on-model frame and two posed drifts, a body proportion
  // and a feature; none of this draws from the rng before the earlier images above, and run 9
  // draws only after run 8. A pose's defect makes its on-model frame drift.
  for (const [run, poses, tag] of [
    ["#108 run 8", POSES_RUN_8, "r8"],
    ["#108 run 9", POSES_RUN_9, "r9"],
  ] as const)
    for (const [birdIndex, name] of names.entries()) {
      const bird = BIRDS[name]!;
      for (const [i, pose] of poses.entries()) {
        const describe = `a frame of one character's "${pose.name}" animation`;
        const extra = { describe, heldOut: run };
        await add(
          `${name}-${tag}-pose-${pose.name}.png`,
          bird,
          name,
          pose.defect ? "drift" : "same",
          `${name} in its "${pose.name}" animation pose (held out, ${run})${pose.defect ? `; defect: ${pose.defect}` : ""}`,
          extra,
          "BIBLE.md",
          pose.view,
        );
        const tall = i % 2 === 0;
        const proportion = {
          params: { ...bird, stretch: (tall ? [1, 1.3] : [1.3, 1]) as [number, number] },
          what: `body stretched 1.3x ${tall ? "tall" : "wide"}`,
        };
        const crest = bird.crest === 3 ? 2 : bird.crest + 1;
        const wing = pick(rng, OTHER_WINGS);
        const lighter = lighten(bird.wing, 0.5);
        const feature = [
          {
            params: { ...bird, wing },
            what: `wing colour changed from ${bird.wing} to ${wing}`,
          },
          {
            params: { ...bird, crest },
            what: `crest feather count changed from ${bird.crest} to ${crest}`,
          },
          {
            params: { ...bird, eyeRing: !bird.eyeRing },
            what: bird.eyeRing ? "eye ring removed" : "eye ring added",
          },
          {
            params: { ...bird, wing: lighter },
            what: `wing a lighter tone of its own hue (${bird.wing} to ${lighter})`,
          },
        ][(i + birdIndex) % 4]!;
        for (const [file, d] of [
          [`${name}-${tag}-pose-drift-proportion-${pose.name}.png`, proportion],
          [`${name}-${tag}-pose-drift-feature-${pose.name}.png`, feature],
        ] as const) {
          if (Object.values(BIRDS).some((b) => differences(d.params, b) === 0))
            throw new Error("a drift variant equals a cast member");
          await add(
            file,
            d.params,
            name,
            "drift",
            `${name} in its "${pose.name}" animation pose, edited: ${d.what} (held out, ${run})`,
            extra,
            "BIBLE.md",
            pose.view,
          );
        }
      }
    }

  await writeFile(join(outDir, "cases.json"), `${JSON.stringify(cases, null, 2)}\n`);
  return { biblePath, conflictBiblePath, cases };
}
