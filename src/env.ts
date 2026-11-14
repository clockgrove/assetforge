/**
 * The one module that reads the environment: settings location, config and state homes, and the
 * variables that can redirect or unwrap the TLS carrying a key.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { InputError } from "./errors.ts";

export type Env = Record<string, string | undefined>;

/** A refusal of settings or the environment they allow; the CLI exits 2 `settings_invalid`. */
export class SettingsError extends InputError {
  readonly code = "settings_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SettingsError";
  }
}

/** Variables that redirect or unwrap TLS; each is refused in either case unless allowed. */
export const REFUSED_VARIABLES = [
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
] as const;

/** The set variables `checkEnvironment` would refuse, by the name they are set under. */
export function refusedVariables(allow: readonly string[] = [], env: Env = process.env): string[] {
  const allowed = new Set(allow.map((name) => name.toUpperCase()));
  const refused: string[] = [];
  for (const name of REFUSED_VARIABLES) {
    if (allowed.has(name)) continue;
    for (const variant of new Set([name, name.toLowerCase()])) {
      if (env[variant]) refused.push(variant);
    }
  }
  return refused;
}

/**
 * Throws `settings_invalid` when a refused variable is set and `environment.allow` does not list
 * it. Run at server start and before every paid command.
 */
export function checkEnvironment(allow: readonly string[] = [], env: Env = process.env): void {
  const refused = refusedVariables(allow, env);
  if (refused.length === 0) return;
  throw new SettingsError(
    `${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} set; each can redirect or unwrap the TLS that carries a key. Unset ${refused.length === 1 ? "it" : "them"}, or list ${refused.length === 1 ? "it" : "them"} in the settings file's environment.allow.`,
  );
}

/** `$ASSETGROVE_CONFIG` when set (empty counts as unset). */
export function configOverride(env: Env = process.env): string | undefined {
  return env["ASSETGROVE_CONFIG"] || undefined;
}

/** `$XDG_CONFIG_HOME` or `~/.config`; `%APPDATA%` on Windows. */
export function configHome(env: Env = process.env, platform: string = process.platform): string {
  if (platform === "win32" && env["APPDATA"] && isAbsolute(env["APPDATA"])) return env["APPDATA"];
  const xdg = env["XDG_CONFIG_HOME"];
  if (platform !== "win32" && xdg && isAbsolute(xdg)) return xdg;
  return join(homeDir(env), platform === "win32" ? join("AppData", "Roaming") : ".config");
}

/** `$XDG_STATE_HOME` or `~/.local/state`; `%LOCALAPPDATA%` on Windows. */
export function stateHome(env: Env = process.env, platform: string = process.platform): string {
  if (platform === "win32" && env["LOCALAPPDATA"] && isAbsolute(env["LOCALAPPDATA"])) {
    return env["LOCALAPPDATA"];
  }
  const xdg = env["XDG_STATE_HOME"];
  if (platform !== "win32" && xdg && isAbsolute(xdg)) return xdg;
  return join(
    homeDir(env),
    platform === "win32" ? join("AppData", "Local") : join(".local", "state"),
  );
}

function homeDir(env: Env): string {
  const home = env["HOME"] || env["USERPROFILE"];
  return home && isAbsolute(home) ? home : homedir();
}
