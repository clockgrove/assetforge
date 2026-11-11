import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { InputError } from "./errors.ts";
import type { BibleReference } from "./types.ts";

export interface IdentityLock {
  version: string;
  approved: true;
  turnaround: string;
  /** Further approved references of the character (paths relative to the bible), if any. */
  references?: string[];
  signatureFeatures: string[];
  proportions: string;
  palette: string[];
}
export interface ArtBible {
  version: string;
  world: string;
  preset: string;
  axes: {
    rendering: "painterly" | "naturalistic" | "flat-cartoon" | "pixel" | "stylised-3d";
    realism: string;
    proportions: string;
    outline: { weight: "none" | "thin" | "bold"; colour: string };
    shading: "soft" | "cel-2-3-tone" | "flat";
    detailDensity: string;
    texture: string;
    lightingKey: string;
  };
  tone: {
    audience: "young-kids" | "all-ages" | "teen" | "mature";
    moodRange: string[];
    contentLimits: string[];
  };
  /**
   * Looks per domain (characters, environment...), keyed by name: each overrides some axes for
   * assets whose spec names it. Anchors with a `look` are used only for that look.
   */
  looks?: Record<string, Partial<ArtBible["axes"]>>;
  anchors: { positive: BibleReference[]; negative: BibleReference[] };
  colorRule: "full" | "palette";
  tokens: Record<string, unknown>;
  adjustable: Record<string, string[] | { min: number; max: number }> & { mood: string[] };
  identities: Record<string, IdentityLock>;
  [section: string]: unknown;
}
export interface BibleDocument {
  path: string;
  dir: string;
  hash: string;
  data: ArtBible;
  prose: string;
}

type Obj = Record<string, unknown>;
function object(value: unknown, label: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InputError(`${label} must be an object`);
  return value as Obj;
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "")
    throw new InputError(`${label} must be a nonempty string`);
}
function strings(value: unknown, label: string, empty = false): asserts value is string[] {
  if (!Array.isArray(value) || (!empty && !value.length))
    throw new InputError(`${label} must be an array of strings`);
  for (const entry of value) text(entry, label);
}
function choice(value: unknown, allowed: string[], label: string) {
  if (typeof value !== "string" || !allowed.includes(value))
    throw new InputError(`${label} must be one of ${allowed.join(", ")}`);
}
function number(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new InputError(`${label} must be a finite number`);
}
function range(min: unknown, max: unknown, label: string) {
  number(min, label);
  number(max, label);
  if (min < 0 || max > 1 || min > max) throw new InputError(`${label} must be ordered within 0..1`);
}
function hex(value: unknown, label: string) {
  if (typeof value !== "string" || !/^#[\da-f]{6}$/i.test(value))
    throw new InputError(`${label} must be a six-digit hex colour`);
}

/** Validate the DTCG types used for art direction, including aliases and inherited group types. */
export function validateTokens(input: unknown): void {
  const root = object(input, "tokens");
  const tokens = new Map<string, { node: Obj; type: unknown }>();
  function collect(group: Obj, path: string[], inherited?: unknown) {
    const type = group["$type"] ?? inherited;
    for (const [name, value] of Object.entries(group)) {
      if (name.startsWith("$")) continue;
      if (/[.{}]/.test(name)) throw new InputError(`invalid DTCG token name ${name}`);
      const node = object(value, `token ${[...path, name].join(".")}`);
      const next = [...path, name];
      if ("$value" in node) {
        if (Object.keys(node).some((key) => !key.startsWith("$")))
          throw new InputError(`DTCG token ${next.join(".")} cannot also be a group`);
        tokens.set(next.join("."), { node, type: node["$type"] ?? type });
      } else collect(node, next, type);
    }
  }
  collect(root, []);
  const active = new Set<string>();
  const complete = new Map<string, unknown>();
  function validate(path: string): unknown {
    const entry = tokens.get(path);
    if (!entry) throw new InputError(`unknown DTCG alias ${path}`);
    if (active.has(path)) throw new InputError(`circular DTCG alias ${path}`);
    if (complete.has(path)) return complete.get(path);
    active.add(path);
    const { node } = entry;
    let type = entry.type;
    const value = node["$value"];
    if (typeof value === "string" && /^\{.+\}$/.test(value)) {
      const referredType = validate(value.slice(1, -1));
      if (node["$type"] !== undefined && node["$type"] !== referredType)
        throw new InputError(`DTCG alias ${path} has a different type`);
      type = node["$type"] ?? referredType;
    } else {
      const label = `DTCG ${path}`;
      switch (type) {
        case "color": {
          const c = object(value, label);
          choice(
            c["colorSpace"],
            [
              "srgb",
              "srgb-linear",
              "hsl",
              "hwb",
              "lab",
              "lch",
              "oklab",
              "oklch",
              "display-p3",
              "a98-rgb",
              "prophoto-rgb",
              "rec2020",
              "xyz-d50",
              "xyz-d65",
            ],
            `${label} colorSpace`,
          );
          if (!Array.isArray(c["components"]) || c["components"].length !== 3)
            throw new InputError(`${label} needs three components`);
          for (const v of c["components"]) if (v !== "none") number(v, label);
          if (
            ["srgb", "srgb-linear", "display-p3", "a98-rgb", "prophoto-rgb", "rec2020"].includes(
              c["colorSpace"] as string,
            )
          )
            for (const v of c["components"])
              if (v !== "none" && ((v as number) < 0 || (v as number) > 1))
                throw new InputError(`${label} RGB components must be 0..1`);
          if (c["alpha"] !== undefined) range(c["alpha"], c["alpha"], label);
          if (c["hex"] !== undefined) hex(c["hex"], label);
          break;
        }
        case "number":
          number(value, label);
          break;
        case "duration": {
          const duration = object(value, label);
          number(duration["value"], label);
          if (duration["value"] < 0) throw new InputError(`${label} duration must be nonnegative`);
          choice(duration["unit"], ["ms", "s"], label);
          break;
        }
        case "cubicBezier": {
          if (!Array.isArray(value) || value.length !== 4)
            throw new InputError(`${label} needs four values`);
          for (const v of value) number(v, label);
          range(value[0], value[0], label);
          range(value[2], value[2], label);
          break;
        }
        default:
          throw new InputError(`${label} uses unsupported DTCG type ${String(type)}`);
      }
    }
    active.delete(path);
    complete.set(path, type);
    return type;
  }
  for (const path of tokens.keys()) validate(path);
}

function tokenType(tokens: Obj, path: string, active = new Set<string>()): unknown {
  if (active.has(path)) throw new InputError(`circular DTCG alias ${path}`);
  active.add(path);
  let node: unknown = tokens;
  let inherited: unknown;
  for (const key of path.split(".")) {
    const group = object(node, `tokens.${path}`);
    inherited = group["$type"] ?? inherited;
    node = group[key];
  }
  const token = object(node, `tokens.${path}`);
  if (token["$type"] !== undefined) return token["$type"];
  const value = token["$value"];
  if (typeof value === "string" && /^\{.+\}$/.test(value))
    return tokenType(tokens, value.slice(1, -1), active);
  return inherited;
}
function tokenValue(tokens: Obj, path: string): unknown {
  let value: unknown = tokens;
  for (const key of path.split(".")) value = object(value, `tokens.${path}`)[key];
  const token = object(value, `tokens.${path}`);
  if (!("$value" in token)) throw new InputError(`tokens.${path} must be a DTCG token`);
  const result = token["$value"];
  return typeof result === "string" && /^\{.+\}$/.test(result)
    ? tokenValue(tokens, result.slice(1, -1))
    : result;
}
export function biblePalette(bible: ArtBible): string[] {
  const palette = object(bible.tokens["palette"], "tokens.palette");
  return Object.keys(palette)
    .filter((name) => !name.startsWith("$"))
    .map((name) => {
      if (tokenType(bible.tokens, `palette.${name}`) !== "color")
        throw new InputError("palette must use color tokens");
      const color = object(tokenValue(bible.tokens, `palette.${name}`), `palette.${name}`);
      if (color["colorSpace"] !== "srgb")
        throw new InputError("bible palette colours must use sRGB");
      const components = color["components"] as number[];
      if (components.some((v) => typeof v !== "number"))
        throw new InputError("palette colours cannot have missing components");
      return `#${components
        .map((v) =>
          Math.round(v * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`;
    });
}
const AXIS_TEXT = ["realism", "proportions", "detailDensity", "texture", "lightingKey"];
function validateAxes(a: Obj, label: string, partial: boolean) {
  const has = (key: string) => !partial || a[key] !== undefined;
  for (const key of Object.keys(a))
    if (![...AXIS_TEXT, "rendering", "outline", "shading"].includes(key))
      throw new InputError(`${label}.${key} is not a style axis`);
  if (has("rendering"))
    choice(
      a["rendering"],
      ["painterly", "naturalistic", "flat-cartoon", "pixel", "stylised-3d"],
      "rendering",
    );
  for (const key of AXIS_TEXT) if (has(key)) text(a[key], `${label}.${key}`);
  if (has("outline")) {
    const outline = object(a["outline"], `${label}.outline`);
    choice(outline["weight"], ["none", "thin", "bold"], "outline.weight");
    text(outline["colour"], "outline.colour");
    if (!/^\{[^{}]+\}$/.test(outline["colour"] as string))
      throw new InputError("outline.colour must reference a DTCG color token");
  }
  if (has("shading")) choice(a["shading"], ["soft", "cel-2-3-tone", "flat"], "shading");
}
export function validateBible(input: unknown): ArtBible {
  const b = object(input, "bible");
  for (const field of ["version", "world", "preset"]) text(b[field], field);
  const a = object(b["axes"], "axes");
  validateAxes(a, "axes", false);
  const outline = object(a["outline"], "outline");
  const looks = b["looks"] === undefined ? {} : object(b["looks"], "looks");
  for (const [name, look] of Object.entries(looks)) {
    text(name, "look name");
    validateAxes(object(look, `looks.${name}`), `looks.${name}`, true);
  }
  const tone = object(b["tone"], "tone");
  choice(tone["audience"], ["young-kids", "all-ages", "teen", "mature"], "audience");
  strings(tone["moodRange"], "moodRange");
  strings(tone["contentLimits"], "contentLimits");
  const anchors = object(b["anchors"], "anchors");
  for (const kind of ["positive", "negative"]) {
    if (!Array.isArray(anchors[kind])) throw new InputError(`anchors.${kind} must be an array`);
    for (const value of anchors[kind]) {
      const anchor = object(value, `anchor ${kind}`);
      text(anchor["path"], "anchor.path");
      text(anchor["role"], "anchor.role");
      if (anchor["subject"] !== undefined) text(anchor["subject"], "anchor.subject");
      if (anchor["look"] !== undefined && !Object.hasOwn(looks, anchor["look"] as string))
        throw new InputError(`anchor ${anchor["path"]} names undeclared look ${anchor["look"]}`);
    }
  }
  choice(b["colorRule"], ["full", "palette"], "colorRule");
  validateTokens(b["tokens"]);
  const tokens = object(b["tokens"], "tokens");
  const outlineTokens = [outline, ...Object.values(looks).map((l) => (l as Obj)["outline"])]
    .filter((o): o is Obj => o !== undefined)
    .map((o) => (o["colour"] as string).slice(1, -1));
  for (const p of ["light", "rim", "fog.colour", ...outlineTokens]) {
    if (tokenType(tokens, p) !== "color") throw new InputError(`tokens.${p} must have color type`);
    object(tokenValue(tokens, p), `tokens.${p}`);
  }
  for (const p of [
    "fog.density",
    "valueRange.min",
    "valueRange.max",
    "saturation.min",
    "saturation.max",
  ])
    if (tokenType(tokens, p) !== "number")
      throw new InputError(`tokens.${p} must have number type`);
  const density = tokenValue(tokens, "fog.density");
  range(density, density, "fog.density");
  range(tokenValue(tokens, "valueRange.min"), tokenValue(tokens, "valueRange.max"), "valueRange");
  range(tokenValue(tokens, "saturation.min"), tokenValue(tokens, "saturation.max"), "saturation");
  const adjustable = object(b["adjustable"], "adjustable");
  strings(adjustable["mood"], "adjustable.mood");
  const protectedFields = new Set([
    "audience",
    "tone",
    "palette",
    "colorRule",
    "identity",
    "identities",
    "contentLimits",
    "rendering",
    "proportions",
    "signatureFeatures",
    "turnaround",
  ]);
  for (const [key, value] of Object.entries(adjustable)) {
    if (protectedFields.has(key) || protectedFields.has(key.split(".")[0] as string))
      throw new InputError(`adjustable.${key} cannot override the constitution`);
    if (Array.isArray(value)) strings(value, `adjustable.${key}`);
    else {
      const bounds = object(value, `adjustable.${key}`);
      number(bounds["min"], `adjustable.${key}.min`);
      number(bounds["max"], `adjustable.${key}.max`);
      if (bounds["min"] > bounds["max"]) throw new InputError(`invalid adjustable.${key} bounds`);
      const tokenRange =
        key === "saturation"
          ? "saturation"
          : ["value", "valueRange"].includes(key)
            ? "valueRange"
            : undefined;
      if (
        tokenRange &&
        (bounds["min"] < (tokenValue(tokens, `${tokenRange}.min`) as number) ||
          bounds["max"] > (tokenValue(tokens, `${tokenRange}.max`) as number))
      )
        throw new InputError(`adjustable.${key} exceeds constitutional token bounds`);
    }
  }
  if (
    (adjustable["mood"] as string[]).some((mood) => !(tone["moodRange"] as string[]).includes(mood))
  )
    throw new InputError("adjustable moods must lie within tone.moodRange");
  const identities = object(b["identities"], "identities");
  for (const [name, value] of Object.entries(identities)) {
    const lock = object(value, `identity ${name}`);
    if (lock["approved"] !== true)
      throw new InputError(`identity ${name} needs an approved turnaround`);
    for (const key of ["version", "turnaround", "proportions"])
      text(lock[key], `identity.${name}.${key}`);
    strings(lock["signatureFeatures"], `identity.${name}.signatureFeatures`);
    strings(lock["palette"], `identity.${name}.palette`);
    if (lock["references"] !== undefined)
      strings(lock["references"], `identity.${name}.references`);
    for (const colour of lock["palette"] as string[]) hex(colour, `identity.${name}.palette`);
  }
  const bible = b as unknown as ArtBible;
  if (!biblePalette(bible).length)
    throw new InputError("palette must contain at least one colour token");
  return bible;
}
export function parseBible(source: string): { data: ArtBible; prose: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) throw new InputError("style bible must be Markdown with YAML front matter");
  try {
    const data = validateBible(parse(match[1] as string));
    const prose = match[2] as string;
    if (!/^##\s+Do['’]s and Don['’]ts\s*$/im.test(prose))
      throw new InputError("style bible must contain a Do's and Don'ts section");
    return { data, prose };
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`invalid bible YAML: ${(error as Error).message}`);
  }
}
export function serializeBible(data: ArtBible, prose: string): string {
  validateBible(data);
  return `---\n${stringify(data)}---\n${prose}`;
}
export async function loadBible(path: string): Promise<BibleDocument> {
  const full = resolve(path);
  let source: string;
  try {
    source = await readFile(full, "utf8");
  } catch (error) {
    throw new InputError(`cannot read style bible ${full}`, { cause: error });
  }
  return {
    path: full,
    dir: dirname(full),
    hash: createHash("sha256").update(source).digest("hex"),
    ...parseBible(source),
  };
}

const color = (hex: string) => ({
  $type: "color",
  $value: {
    colorSpace: "srgb",
    components: [1, 3, 5].map((n) => parseInt(hex.slice(n, n + 2), 16) / 255),
  },
});
const numeric = (value: number) => ({ $type: "number", $value: value });
function preset(
  rendering: ArtBible["axes"]["rendering"],
  shading: ArtBible["axes"]["shading"],
  audience: ArtBible["tone"]["audience"],
  texture: string,
  lightingKey: string,
): ArtBible {
  return {
    version: "1",
    world: "Your world",
    preset: "",
    axes: {
      rendering,
      realism: "clearly stylised, original fictional forms",
      proportions: "readable silhouettes with expressive heads",
      outline: { weight: rendering === "flat-cartoon" ? "bold" : "none", colour: "{outline}" },
      shading,
      detailDensity: rendering === "flat-cartoon" ? "low" : "medium",
      texture,
      lightingKey,
    },
    tone: {
      audience,
      moodRange:
        audience === "young-kids"
          ? ["cheerful", "calm", "curious"]
          : ["warm", "calm", "mildly eerie"],
      contentLimits: ["no graphic violence", "no sexual content", "no hateful imagery"],
    },
    anchors: { positive: [], negative: [] },
    colorRule: "full",
    tokens: {
      palette: { ink: color("#292433"), warm: color("#c49b70"), cool: color("#7c93a8") },
      light: color("#fff0d6"),
      rim: color("#a6c4e8"),
      fog: { colour: color("#a1aabd"), density: numeric(0.1) },
      valueRange: { min: numeric(0.1), max: numeric(0.95) },
      saturation: { min: numeric(0.2), max: numeric(0.8) },
      outline: color("#292433"),
    },
    adjustable: {
      mood:
        audience === "young-kids"
          ? ["cheerful", "calm", "curious"]
          : ["warm", "calm", "mildly eerie"],
    },
    identities: {},
  };
}
export const BIBLE_PRESETS: Record<string, ArtBible> = {
  "cozy-storybook": preset(
    "painterly",
    "soft",
    "all-ages",
    "visible gentle brushwork, soft tactile surfaces",
    "soft diffuse warm key light",
  ),
  "flat-cartoon-kids": preset(
    "flat-cartoon",
    "flat",
    "young-kids",
    "clean solid colour regions, no surface grain",
    "even bright illumination",
  ),
  "dark-gritty-isometric": preset(
    "stylised-3d",
    "cel-2-3-tone",
    "teen",
    "weathered surfaces with restrained fine grain",
    "low-key directional light, isometric camera",
  ),
};
for (const [name, value] of Object.entries(BIBLE_PRESETS)) value.preset = name;
BIBLE_PRESETS["dark-gritty-isometric"]!.tone.moodRange = ["somber", "tense", "mildly eerie"];
BIBLE_PRESETS["dark-gritty-isometric"]!.adjustable.mood = ["somber", "tense", "mildly eerie"];
BIBLE_PRESETS["dark-gritty-isometric"]!.tokens["saturation"] = {
  min: numeric(0.1),
  max: numeric(0.5),
};
BIBLE_PRESETS["dark-gritty-isometric"]!.tokens["valueRange"] = {
  min: numeric(0.05),
  max: numeric(0.65),
};

export async function describeBible(path: string) {
  const document = await loadBible(path);
  return {
    ...document.data,
    path: document.path,
    hash: document.hash,
    prose: document.prose,
    palette: biblePalette(document.data),
    presets: Object.keys(BIBLE_PRESETS),
    doDont: doDontSection(document.prose),
  };
}
export function doDontSection(prose: string): string {
  return (
    /^##\s+Do['’]s and Don['’]ts\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im
      .exec(prose)?.[1]
      ?.trim() ?? ""
  );
}
export async function initBible(options: { directory: string; world: string; preset: string }) {
  const chosen = BIBLE_PRESETS[options.preset];
  if (!chosen) throw new InputError(`unknown preset ${options.preset}`);
  text(options.world, "world");
  const directory = resolve(options.directory);
  const biblePath = join(directory, ".assetforge/art-direction/BIBLE.md");
  const skillPath = join(dirname(biblePath), "SKILL.md");
  const templatePath = join(directory, ".assetforge/prompts/default.md");
  const data = structuredClone(chosen);
  data.world = options.world;
  const prose = `# ${options.world} art direction\n\nGenerate original work using the axes and tokens above. Add rationale and reference images here.\n\n## Do's and Don'ts\n\nDo follow the positive anchors. Don't reproduce the negative anchors or violate content limits.\n`;
  const destinations = [
    biblePath,
    skillPath,
    templatePath,
    ...Object.keys(BIBLE_PRESETS).map((name) => join(dirname(biblePath), "presets", `${name}.md`)),
  ];
  for (const path of destinations) {
    try {
      await access(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new InputError(`refusing to overwrite ${path}`);
  }
  await mkdir(dirname(biblePath), { recursive: true });
  await mkdir(dirname(templatePath), { recursive: true });
  await writeFile(biblePath, serializeBible(data, prose), { flag: "wx" });
  await writeFile(
    skillPath,
    `---\n${stringify({ name: "world-art-direction", description: `Load when generating or reviewing art for ${options.world}.` })}---\n# Art direction\n\nRead [the style bible](BIBLE.md), including its positive and negative anchor paths and Do's and Don'ts.\nSee [starting presets](presets/) for visual alternatives. The bible is a constitution; briefs cannot override it.\n`,
    { flag: "wx" },
  );
  await writeFile(
    templatePath,
    await readFile(new URL("../skills/art-direction/default.md", import.meta.url), "utf8"),
    { flag: "wx" },
  );
  await mkdir(join(dirname(biblePath), "presets"), { recursive: true });
  for (const [name, value] of Object.entries(BIBLE_PRESETS))
    await writeFile(
      join(dirname(biblePath), "presets", `${name}.md`),
      serializeBible(value, prose),
      { flag: "wx" },
    );
  return { biblePath, skillPath, templatePath };
}

export async function loadDesignColors(
  directory: string,
  purpose: string,
): Promise<unknown | undefined> {
  if (!/\b(icon|portrait|badge|ui)\b/i.test(purpose)) return undefined;
  let source: string;
  try {
    source = await readFile(join(directory, "DESIGN.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  const blocks = [
    ...(front ? [front[1] as string] : []),
    ...Array.from(
      source.matchAll(/^```ya?ml[^\n]*\r?\n([\s\S]*?)^```\s*$/gm),
      (match) => match[1] as string,
    ),
  ];
  const colors: Obj = {};
  for (const block of blocks) {
    const parsed = parse(block);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const candidate = (parsed as Obj)["colors"];
    if (candidate !== undefined) Object.assign(colors, object(candidate, "DESIGN.md colors"));
  }
  return Object.keys(colors).length ? colors : undefined;
}

/** Explicitly replace look/tone from a target-owned preset while retaining world identity and palette. */
export async function useBiblePreset(options: { biblePath: string; preset: string }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.preset))
    throw new InputError("preset must be a lowercase slug");
  const document = await loadBible(options.biblePath);
  const selected = await loadBible(join(document.dir, "presets", `${options.preset}.md`));
  const data = structuredClone(document.data);
  data.preset = options.preset;
  data.axes = structuredClone(selected.data.axes);
  data.tone = structuredClone(selected.data.tone);
  data.adjustable = structuredClone(selected.data.adjustable);
  data.tokens = {
    ...data.tokens,
    ...structuredClone(selected.data.tokens),
    palette: data.tokens["palette"],
  };
  validateBible(data);
  await writeFile(document.path, serializeBible(data, document.prose));
  return describeBible(document.path);
}
