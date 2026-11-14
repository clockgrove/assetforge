/**
 * Developer settings: the one per-user file outside every project, and the only input that steers
 * money, code or keys. `loadSettings` finds it, refuses it structurally (exit 2 `settings_invalid`)
 * and fills the defaults. Nothing here reads a key.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { configHome, configOverride, SettingsError, stateHome, type Env } from "./env.ts";
import { FormatError, readFormat } from "./formats.ts";

export { SettingsError } from "./env.ts";

export const DEFAULT_CAPS = { runUsd: 5, dailyUsd: 10, workItemUsd: 5 } as const;

/** Field names that would hold a secret; refused anywhere in the file, in any case. */
const SECRET_FIELDS = new Set(["apikey", "key", "token", "secret"]);

const usd = z.number().finite().nonnegative();
const hex = z.string().regex(/^[0-9a-f]+$/i, "must be hexadecimal");
const name = z.string().min(1);

export const LIMIT_KINDS = [
  "key-budget",
  "team-budget",
  "project-hard-limit",
  "workspace-limit",
  "prepaid",
  "unlimited",
] as const;

const limitSchema = z
  .strictObject({
    kind: z.enum(LIMIT_KINDS),
    usd: usd.optional(),
    period: name.optional(),
    acceptUnlimited: z.boolean().optional(),
  })
  .refine((limit) => limit.kind !== "unlimited" || limit.acceptUnlimited === true, {
    message: 'kind "unlimited" needs acceptUnlimited: true',
    path: ["acceptUnlimited"],
  });

const providerSchema = z.strictObject({
  adapter: name.optional(),
  keyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name")
    .optional(),
  baseURL: z.url().optional(),
  free: z.boolean().optional(),
  usdPerCredit: z.number().finite().positive().optional(),
  limit: limitSchema.optional(),
});

const outputGrantSchema = z.looseObject({
  license: z.string().optional(),
  plan: z.string().optional(),
  commercial: z.boolean().optional(),
  relabel: z.boolean().optional(),
  attribution: z.string().optional(),
});

const settingsSchema = z.strictObject({
  format: z.string(),
  stateDir: z.string().refine(isAbsolute, "must be an absolute path").optional(),
  headless: z.strictObject({ operator: name }).optional(),
  caps: z
    .strictObject({ runUsd: usd.optional(), dailyUsd: usd.optional(), workItemUsd: usd.optional() })
    .optional(),
  providers: z.record(name, providerSchema).optional(),
  roles: z
    .record(
      name,
      z.strictObject({
        provider: name,
        model: name,
        outputGrant: outputGrantSchema.optional(),
        providerTerms: z.string().optional(),
      }),
    )
    .optional(),
  routes: z.record(name, z.strictObject({ provider: name, model: name })).optional(),
  extensions: z.array(name).optional(),
  environment: z.strictObject({ allow: z.array(name) }).optional(),
  reconcile: z
    .strictObject({ marginUsd: usd.optional(), marginPct: z.number().finite().min(0).optional() })
    .optional(),
  spend: z.strictObject({ acknowledgedHolds: z.array(hex) }).optional(),
  commands: z
    .strictObject({
      approved: z.array(
        z.strictObject({
          hash: hex,
          kind: name,
          argv: z.array(z.string()).min(1),
          cwd: z.string().optional(),
          note: z.string().optional(),
        }),
      ),
    })
    .optional(),
  promptPolicy: z.strictObject({ allow: z.array(name) }).optional(),
  confirmedBy: z
    .record(name, z.strictObject({ method: name, at: name, client: z.string().optional() }))
    .optional(),
});

/** The settings file as written, after validation. */
export type SettingsFile = z.infer<typeof settingsSchema>;
export type ProviderSettings = z.infer<typeof providerSchema>;
export type ProviderLimit = z.infer<typeof limitSchema>;

/** Settings with every default filled. */
export interface Settings {
  /** The file the settings came from, whether or not it exists. */
  path: string;
  /** The directory holding the file; confirmation and approval records go beside it. */
  configDir: string;
  /** False when no file exists and these are the defaults. */
  exists: boolean;
  /** The settings file's format version before an in-memory migration. */
  migratedFrom?: number;
  stateDir: string;
  mode: "attended" | "headless";
  headless?: { operator: string };
  caps: { runUsd: number; dailyUsd: number; workItemUsd: number };
  providers: Record<string, ProviderSettings>;
  roles: NonNullable<SettingsFile["roles"]>;
  routes: NonNullable<SettingsFile["routes"]>;
  extensions: string[];
  environment: { allow: string[] };
  reconcile: NonNullable<SettingsFile["reconcile"]>;
  spend: { acknowledgedHolds: string[] };
  commands: NonNullable<SettingsFile["commands"]>;
  promptPolicy: { allow: string[] };
  confirmedBy: NonNullable<SettingsFile["confirmedBy"]>;
}

export interface LoadOptions {
  env?: Env;
  /** The working directory; its Git top level is a project the file may not be inside. */
  cwd?: string;
  /** `--target`, when the command has one. */
  target?: string;
  /** Every input file the command reads. */
  inputs?: readonly string[];
  /** Decides case-insensitive containment (win32, darwin) and the config home. */
  platform?: string;
}

/** Where the settings file is: `$ASSETGROVE_CONFIG`, else `<configHome>/assetgrove/settings.json`. */
export function settingsPath(env: Env = process.env, platform: string = process.platform): string {
  const override = configOverride(env);
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new SettingsError(`ASSETGROVE_CONFIG must be an absolute path; got "${override}".`);
    }
    return override;
  }
  return join(configHome(env, platform), "assetgrove", "settings.json");
}

/** Finds, validates and completes the developer settings. Throws `SettingsError` on any refusal. */
export function loadSettings(options: LoadOptions = {}): Settings {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = settingsPath(env, platform);
  const configDir = dirname(path);
  const projects = projectRoots(options);
  const defaultStateDir = join(stateHome(env, platform), "assetgrove");

  if (!existsSync(path)) {
    if (configOverride(env) !== undefined) {
      throw new SettingsError(`ASSETGROVE_CONFIG names ${path}, which does not exist.`);
    }
    return complete({ format: "assetgrove-settings/1" }, path, configDir, false, defaultStateDir);
  }

  const real = realpathSync(path);
  const project = projects.find((root) => isInside(real, root, platform));
  if (project !== undefined) {
    throw new SettingsError(
      `The settings file ${path} is inside the project ${project}; developer settings must live outside every repository.`,
    );
  }
  if (!statSync(real).isFile()) throw new SettingsError(`${path} is not a file.`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(real, "utf8"));
  } catch (error) {
    throw new SettingsError(`${path} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }

  const secret = secretField(raw, []);
  if (secret !== undefined) {
    throw new SettingsError(
      `${path} has a field named "${secret.at(-1)}" at ${secret.join(".")}; settings never hold a key. Name the environment variable that holds it with keyEnv.`,
    );
  }

  let migrated;
  try {
    migrated = readFormat("settings", raw, path);
  } catch (error) {
    if (error instanceof FormatError) throw new SettingsError(error.message, { cause: error });
    throw error;
  }

  const parsed = settingsSchema.safeParse(migrated.value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "(top level)";
      return `${at}: ${issue.message}`;
    });
    throw new SettingsError(`${path} is invalid: ${issues.join("; ")}`, { cause: parsed.error });
  }
  const file = parsed.data;

  checkProviders(file, path);
  if (file.stateDir !== undefined) {
    const stateReal = realIfExists(resolve(file.stateDir));
    const inside = projects.find((root) => isInside(stateReal, root, platform));
    if (inside !== undefined) {
      throw new SettingsError(
        `${path}: stateDir ${file.stateDir} is inside the project ${inside}.`,
      );
    }
  }

  const settings = complete(file, path, configDir, true, defaultStateDir);
  if (migrated.migratedFrom !== undefined) settings.migratedFrom = migrated.migratedFrom;
  return settings;
}

function complete(
  file: SettingsFile,
  path: string,
  configDir: string,
  exists: boolean,
  defaultStateDir: string,
): Settings {
  return {
    path,
    configDir,
    exists,
    stateDir: file.stateDir ?? defaultStateDir,
    mode: file.headless ? "headless" : "attended",
    ...(file.headless && { headless: file.headless }),
    caps: { ...DEFAULT_CAPS, ...file.caps },
    providers: file.providers ?? {},
    roles: file.roles ?? {},
    routes: file.routes ?? {},
    extensions: file.extensions ?? [],
    environment: { allow: file.environment?.allow ?? [] },
    reconcile: file.reconcile ?? {},
    spend: { acknowledgedHolds: file.spend?.acknowledgedHolds ?? [] },
    commands: file.commands ?? { approved: [] },
    promptPolicy: { allow: file.promptPolicy?.allow ?? [] },
    confirmedBy: file.confirmedBy ?? {},
  };
}

/** Endpoint and reference refusals zod's per-field schema cannot express. */
function checkProviders(file: SettingsFile, path: string): void {
  const providers = file.providers ?? {};
  for (const [id, provider] of Object.entries(providers)) {
    const url = provider.baseURL !== undefined ? new URL(provider.baseURL) : undefined;
    const loopback = url !== undefined && isLoopback(url.hostname);
    if (url !== undefined && url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new SettingsError(
        `${path}: providers.${id}.baseURL must be https, or http on a loopback host; got ${provider.baseURL}.`,
      );
    }
    if (provider.free === true && !loopback) {
      throw new SettingsError(
        `${path}: providers.${id}.free is allowed only with a loopback baseURL (localhost, 127.0.0.0/8 or [::1]).`,
      );
    }
  }
  for (const section of ["roles", "routes"] as const) {
    for (const [entry, value] of Object.entries(file[section] ?? {})) {
      if (!Object.hasOwn(providers, value.provider)) {
        throw new SettingsError(
          `${path}: ${section}.${entry} names provider "${value.provider}", which is not in providers.`,
        );
      }
    }
  }
}

/** True for localhost, 127.0.0.0/8 and ::1. */
export function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** The path of the first field named like a secret, depth-first. */
function secretField(value: unknown, at: string[]): string[] | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = secretField(item, [...at, String(index)]);
      if (found) return found;
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [field, item] of Object.entries(value)) {
      if (SECRET_FIELDS.has(field.toLowerCase())) return [...at, field];
      const found = secretField(item, [...at, field]);
      if (found) return found;
    }
  }
  return undefined;
}

/** The Git top levels of the cwd, `--target` and every input file: the projects in play. */
function projectRoots(options: LoadOptions): string[] {
  const starts = [
    options.cwd ?? process.cwd(),
    ...(options.target !== undefined ? [options.target] : []),
    ...(options.inputs ?? []).map((input) => dirname(resolve(input))),
  ];
  const roots = new Set<string>();
  for (const start of starts) {
    const root = gitTopLevel(start);
    if (root !== undefined) roots.add(root);
  }
  return [...roots];
}

/** The nearest directory at or above `start` that holds `.git`, by real path. */
export function gitTopLevel(start: string): string | undefined {
  let dir = realIfExists(resolve(start));
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** True when `child` is `parent` or inside it; case-insensitive on win32 and darwin. */
export function isInside(
  child: string,
  parent: string,
  platform: string = process.platform,
): boolean {
  const fold = (path: string) => {
    let normal = platform === "win32" || sep === "\\" ? path.replace(/\\/g, "/") : path;
    normal = normal.replace(/\/+$/, "");
    return platform === "win32" || platform === "darwin" ? normal.toLowerCase() : normal;
  };
  const c = fold(child);
  const p = fold(parent);
  return c === p || c.startsWith(`${p}/`) || (p === "" && c.startsWith("/"));
}

/** The real path of `path`, or of its nearest existing ancestor joined with the rest. */
function realIfExists(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) return path;
  return join(realIfExists(parent), path.slice(parent.length).replace(/^[\\/]+/, ""));
}
