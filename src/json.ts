import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { InputError } from "./errors.ts";

/** Reads and parses a JSON file; an unreadable or malformed file is an InputError (exit 2). */
export async function parseJsonFile(path: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : String(error);
    throw new InputError(`cannot read ${what} ${path}: ${reason}`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InputError(`${what} ${path} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/** Reads a JSON data file and returns it with the directory its relative paths resolve against. */
export async function readJson<T>(path: string): Promise<{ value: T; dir: string }> {
  const full = resolve(path);
  return { value: (await parseJsonFile(full, "file")) as T, dir: dirname(full) };
}
