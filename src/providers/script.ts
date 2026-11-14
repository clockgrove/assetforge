import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InputError } from "../errors.ts";
import type { Script } from "../gateway/scripted.ts";

/** Loads a --provider-script module, whose default export must be { image, vision } functions. */
export async function loadScript(path: string): Promise<Script> {
  let mod: { default?: Partial<Script> };
  try {
    mod = (await import(pathToFileURL(resolve(path)).href)) as typeof mod;
  } catch (error) {
    throw new InputError(`cannot load provider script ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const script = mod.default;
  if (typeof script?.image !== "function" || typeof script.vision !== "function") {
    throw new InputError(`provider script ${path} must default-export { image, vision } functions`);
  }
  return script as Script;
}
