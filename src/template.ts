/**
 * The template language target profiles use for layouts and manifests.
 *
 * - A string that is exactly `"{{a.b}}"` is replaced by the value at `a.b`, of any JSON type.
 * - `"{{a.b?}}"` does the same, but an undefined value removes the key (or array item).
 * - `{{a.b}}` inside a longer string is interpolated as text.
 *
 * An undefined value without `?` is an error, so a profile cannot silently write a hole.
 */

const WHOLE = /^\{\{\s*([\w.-]+)(\?)?\s*\}\}$/;
const INLINE = /\{\{\s*([\w.-]+)\s*\}\}/g;
const OMIT = Symbol("omit");

export function lookup(context: unknown, path: string): unknown {
  let value: unknown = context;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function renderString(template: string, context: unknown): string {
  return template.replace(INLINE, (_, path: string) => {
    const value = lookup(context, path);
    if (value === undefined) throw new Error(`template value "${path}" is undefined`);
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function renderValue(template: unknown, context: unknown): unknown {
  if (typeof template === "string") {
    const whole = WHOLE.exec(template);
    if (whole?.[1]) {
      const value = lookup(context, whole[1]);
      if (value === undefined) {
        if (whole[2]) return OMIT;
        throw new Error(`template value "${whole[1]}" is undefined`);
      }
      return structuredClone(value);
    }
    return renderString(template, context);
  }
  if (Array.isArray(template)) {
    return template.map((item) => renderValue(item, context)).filter((item) => item !== OMIT);
  }
  if (template !== null && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(template)) {
      const value = renderValue(item, context);
      if (value !== OMIT) out[key] = value;
    }
    return out;
  }
  return template;
}

export function render(template: unknown, context: unknown): unknown {
  const value = renderValue(template, context);
  return value === OMIT ? undefined : value;
}

/** Sets `value` at a dotted path, creating objects on the way. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (next === null || typeof next !== "object" || Array.isArray(next)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1] as string] = value;
}
