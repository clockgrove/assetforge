import { readFile } from "node:fs/promises";
import { loadBible } from "./bible.ts";
import { InputError } from "./errors.ts";
import { identitySettings, loadCast, loadIdentity } from "./identity.ts";
import { readJson } from "./json.ts";
import { parseDigitalSourceType } from "./metadata.ts";
import type { DigitalSourceType } from "./metadata.ts";
import type { SliceOptions } from "./sheet/types.ts";
import { resolveStyle } from "./style.ts";
import type { AssetSpec, TargetProfile } from "./types.ts";

export { readJson } from "./json.ts";

/** The bytes of a file; an unreadable file is an InputError naming what it is. */
export async function readBytes(path: string, what: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    throw new InputError(`cannot read ${what} ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/** A 3D model file's bytes and path. */
export async function readModel(path: string): Promise<{ bytes: Uint8Array; path: string }> {
  try {
    return { bytes: new Uint8Array(await readFile(path)), path };
  } catch {
    throw new InputError(`cannot read the model ${path}`);
  }
}

/**
 * The identity lock of `subject` from `--lock-bible`, with the run's identity settings
 * (`--identity-mode` over the profile's). Undefined when the subject has no lock or scoring is off.
 */
export async function lockFor(
  lockBible: string | undefined,
  identityMode: string | undefined,
  subject: string,
  profile: TargetProfile,
) {
  const settings = identitySettings(profile, identityMode);
  if (lockBible === undefined) {
    if (identityMode !== undefined)
      throw new InputError("--identity-mode needs --lock-bible <BIBLE.md>");
    return undefined;
  }
  const doc = await loadBible(lockBible);
  const loaded = await loadIdentity(doc, subject);
  if (!loaded || settings.mode === "off") return undefined;
  return {
    ...loaded,
    settings,
    ...(settings.question === "cast" && { cast: await loadCast(doc) }),
  };
}

/**
 * The subject and gait an asset spec given with `--spec` declares, for animation QA. The gait
 * picks each motion template's rule for it (the spec's over the profile's `animation.gait`).
 */
export async function specForQa(
  specPath: string | undefined,
): Promise<{ subject?: string; gait?: string }> {
  if (specPath === undefined) return {};
  const spec = (await readJson<AssetSpec>(specPath)).value;
  if (spec.gait !== undefined && typeof spec.gait !== "string") {
    throw new InputError(`the spec's gait must be text, for example "quadruped"`);
  }
  return {
    ...(typeof spec.subject === "string" && { subject: spec.subject }),
    ...(spec.gait !== undefined && { gait: spec.gait }),
  };
}

/** The style and frame size a target profile supplies to a transformation, when it has them. */
export async function profileContext(path: string | undefined) {
  if (path === undefined) return {};
  const profile = (await readJson<TargetProfile>(path)).value;
  const frames = profile.frames as Partial<TargetProfile["frames"]> | undefined;
  return {
    ...(profile.style !== undefined && { style: resolveStyle(profile.style) }),
    ...(frames?.width !== undefined &&
      frames.height !== undefined && { frame: { width: frames.width, height: frames.height } }),
  };
}

/** The IPTC digital source type of `--digital-source-type`, when given. */
export function declarationOption(code: string | undefined): DigitalSourceType | undefined {
  if (code === undefined) return undefined;
  const value = parseDigitalSourceType(code);
  if (!value) throw new InputError(`invalid --digital-source-type: ${code}`);
  return value;
}

/** How to slice a sheet: by `--components`, a `--grid` of columns or detection, with a count. */
export function sliceOptions(
  grid: number | undefined,
  components: boolean | undefined,
  count: number | undefined,
): SliceOptions {
  const counted = count !== undefined ? { count } : {};
  if (components) return { components: true, ...counted };
  if (grid === undefined) return counted;
  return { grid: { columns: grid }, ...counted };
}
