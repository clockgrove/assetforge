import { InputError, ProviderError } from "../errors.ts";
import type { Caller } from "../calls.ts";
import type { LoadedReference } from "../types.ts";
import type { FamilyGroup, Grouping } from "./types.ts";

export interface GroupingPromptInput {
  frameIds: number[];
  subject?: string;
  subjectDescription?: string;
  /** Suggested family names, from the caller. */
  hints?: string[];
  /** Roles of the reference images, in the order attached after the contact sheet. */
  referenceRoles?: string[];
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function normaliseName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildGroupingPrompt(input: GroupingPromptInput): string {
  const lines = [
    `You are grouping the frames of a sprite sheet${input.subject ? ` of "${input.subject}"` : ""} into animation families.`,
    ...(input.subjectDescription ? [`Subject: ${input.subjectDescription}`] : []),
    `Image 1 is a contact sheet of the cleaned, registered frames, each numbered below it. The frame numbers are: ${input.frameIds.join(", ")}.`,
    ...(input.referenceRoles ?? []).map(
      (role, i) => `Image ${i + 2} is a reference with role "${role}".`,
    ),
    "Propose animation families: each lists its frames in play order.",
    "If one family is a horizontal mirror of another (for example a left walk that is the right walk flipped), set mirrorOf to the other family's name and give no frames; do this only when it fits, otherwise list the family's own frames.",
    ...(input.hints && input.hints.length > 0
      ? [`Suggested family names, to use where they fit: ${input.hints.join(", ")}.`]
      : []),
    "Name families in lowercase-hyphenated form. Give a short reason for each family. List frames that belong to no family in unassigned.",
    'Reply with ONLY a JSON object, no other text: {"families":[{"name":"...","frames":[1,2],"mirrorOf":"...","reason":"..."}],"unassigned":[...],"notes":"..."}',
  ];
  return lines.join("\n");
}

export function parseGrouping(text: string, frameIds: number[]): Grouping {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    parsed = undefined;
  }
  const rawFamilies = (parsed as { families?: unknown } | null | undefined)?.families;
  if (!Array.isArray(rawFamilies)) {
    throw new ProviderError("the vision reply contained no JSON object with a families array");
  }
  const known = new Set(frameIds);
  const notes: string[] = [];
  const raw = parsed as { notes?: unknown };
  if (typeof raw.notes === "string" && raw.notes) notes.push(raw.notes);

  const families: FamilyGroup[] = [];
  const mirrors = new Map<FamilyGroup, string>();
  for (const item of rawFamilies) {
    const f = item as Record<string, unknown> | null;
    if (!f || typeof f.name !== "string") continue;
    const name = normaliseName(f.name);
    if (!name || families.some((g) => g.name === name)) {
      notes.push(`dropped family "${f.name}": empty or duplicate name`);
      continue;
    }
    const reason = typeof f.reason === "string" && f.reason.trim() ? f.reason : "no reason given";
    const family: FamilyGroup = { name, reason };
    if (Array.isArray(f.frames)) {
      const seen = new Set<number>();
      const frames: number[] = [];
      for (const id of f.frames) {
        if (typeof id !== "number" || !known.has(id)) {
          notes.push(`family "${name}": dropped unknown frame ${String(id)}`);
        } else if (seen.has(id)) {
          notes.push(`family "${name}": dropped duplicate frame ${id}`);
        } else {
          seen.add(id);
          frames.push(id);
        }
      }
      family.frames = frames;
    }
    if (typeof f.mirrorOf === "string" && f.mirrorOf.trim()) mirrors.set(family, f.mirrorOf);
    families.push(family);
  }
  for (const [family, target] of mirrors) {
    const targetName = normaliseName(target);
    if (targetName !== family.name && families.some((g) => g.name === targetName)) {
      family.mirrorOf = targetName;
    } else {
      notes.push(
        `family "${family.name}": dropped mirrorOf "${target}", which names no other family`,
      );
    }
  }

  const used = new Set(families.flatMap((f) => f.frames ?? []));
  const unassigned = frameIds.filter((id) => !used.has(id));
  return {
    status: "proposed",
    families,
    unassigned,
    ...(notes.length > 0 && { notes: notes.join("; ") }),
  };
}

export async function proposeGrouping(
  call: Caller,
  contact: LoadedReference,
  references: LoadedReference[],
  input: GroupingPromptInput,
): Promise<Grouping> {
  const prompt = buildGroupingPrompt(input);
  const text = await call.vision("vision", prompt, [contact, ...references]);
  const grouping = parseGrouping(text, input.frameIds);
  const record = call.records[call.records.length - 1];
  if (record) grouping.proposedBy = { model: record.model, requestId: record.requestId };
  return grouping;
}

export function checkConfirmed(grouping: unknown, frameIds: number[]): Grouping {
  const g = grouping as Partial<Grouping> | null;
  if (!g || typeof g !== "object") throw new InputError("the grouping file is not an object");
  if (g.status !== "confirmed") {
    throw new InputError(
      'the grouping is not confirmed: review the proposal, edit it as needed, and set status to "confirmed"',
    );
  }
  if (!Array.isArray(g.families) || g.families.length === 0) {
    throw new InputError("the grouping has no families");
  }
  const known = new Set(frameIds);
  const byName = new Map<string, FamilyGroup>();
  for (const f of g.families) {
    if (!f || typeof f.name !== "string" || !NAME_PATTERN.test(f.name)) {
      throw new InputError(
        `family name ${JSON.stringify(f?.name)} must be lowercase letters, digits and hyphens`,
      );
    }
    if (byName.has(f.name)) throw new InputError(`duplicate family name "${f.name}"`);
    byName.set(f.name, f);
  }
  for (const f of g.families) {
    const hasFrames = Array.isArray(f.frames) && f.frames.length > 0;
    const hasMirror = f.mirrorOf !== undefined;
    if (hasFrames && hasMirror) {
      throw new InputError(`family "${f.name}" has both frames and mirrorOf; use one`);
    }
    if (!hasFrames && !hasMirror) {
      throw new InputError(`family "${f.name}" has neither frames nor mirrorOf`);
    }
    if (hasFrames) {
      for (const id of f.frames ?? []) {
        if (!known.has(id))
          throw new InputError(`family "${f.name}" names unknown frame ${String(id)}`);
      }
    } else {
      const target = typeof f.mirrorOf === "string" ? byName.get(f.mirrorOf) : undefined;
      if (!target || target === f) {
        throw new InputError(
          `family "${f.name}" mirrors "${String(f.mirrorOf)}", which is not another family`,
        );
      }
      if (target.mirrorOf !== undefined || !target.frames || target.frames.length === 0) {
        throw new InputError(
          `family "${f.name}" mirrors "${target.name}", which has no frames of its own (no mirror chains)`,
        );
      }
    }
  }
  return g as Grouping;
}

export function familyFrames(
  grouping: Grouping,
  name: string,
): { frames: number[]; mirrored: boolean } {
  const family = grouping.families.find((f) => f.name === name);
  if (!family) throw new InputError(`no family named "${name}"`);
  if (family.mirrorOf !== undefined) {
    const target = grouping.families.find((f) => f.name === family.mirrorOf);
    if (!target?.frames)
      throw new InputError(`family "${name}" mirrors "${family.mirrorOf}", which has no frames`);
    return { frames: [...target.frames], mirrored: true };
  }
  return { frames: [...(family.frames ?? [])], mirrored: false };
}
