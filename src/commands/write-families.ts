import { join } from "node:path";
import { formatReport } from "../animation/run.ts";
import { readJson } from "../inputs.ts";
import { DEFAULT_JITTER_BOUND_PX, GROUPING_FILE, writeFamilies } from "../sheet/import.ts";
import { refusal } from "./result.ts";
import { defineCommand } from "./types.ts";

interface WriteFamiliesArgs {
  import: string;
  target: string;
  grouping?: string;
  jitterBound?: number;
}

export const writeFamiliesCommand = defineCommand<WriteFamiliesArgs>({
  name: "write-families",
  tool: null,
  summary: "write the strips of a human-confirmed grouping into the target, review pending",
  details: `Writes one strip and manifest per family of a grouping whose status a human set to
"confirmed" into the target with review pending, registered within the jitter bound in pixels.
Agents never confirm a grouping.`,
  input: {
    type: "object",
    properties: {
      import: {
        type: "string",
        description: "the import directory",
        placeholder: "<import directory>",
      },
      target: {
        type: "string",
        description: "the directory to write into",
        placeholder: "<target directory>",
      },
      grouping: {
        type: "string",
        description: "the confirmed grouping",
        placeholder: "<import>/grouping.json",
      },
      jitterBound: {
        type: "number",
        description: "the registration jitter bound in pixels",
        default: DEFAULT_JITTER_BOUND_PX,
      },
    },
    required: ["import", "target"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "never", writes: "target" },
  async run(args) {
    const importDir = args.import;
    const groupingPath = args.grouping ?? join(importDir, GROUPING_FILE);
    const result = await writeFamilies({
      importDir,
      grouping: (await readJson<unknown>(groupingPath)).value,
      targetDir: args.target,
      jitterBoundPx: args.jitterBound ?? DEFAULT_JITTER_BOUND_PX,
    });
    const lines: string[] = [];
    for (const f of result.families) {
      lines.push(
        `${f.name}: ${f.frames.length} frames${f.mirrored ? " (mirrored)" : ""}, jitter ${f.jitterPx.toFixed(2)} px`,
        `  wrote ${f.result.mediaPath}`,
        `  wrote ${f.result.manifestPath}`,
      );
      if (f.result.provenancePath) lines.push(`  wrote ${f.result.provenancePath}`);
      lines.push(
        ...formatReport({ ...f.animation, identityFlicker: "skipped", holes: "skipped" }).map(
          (l) => `  ${l}`,
        ),
      );
      lines.push(`  onion skin ${f.onionPath}`, `  loop preview ${f.loopPreviewPath}`);
      if (f.result.validator) {
        lines.push(
          `  target validator ${f.result.validator.accepted ? "accepted" : "REJECTED"} it` +
            (f.result.validator.output ? `: ${f.result.validator.output}` : ""),
        );
      }
    }
    lines.push(`preview loop: ${result.previewPath}`);
    const fields = { ...result };
    const human = lines.join("\n");
    if (result.families.some((f) => f.result.validator?.accepted === false)) {
      return refusal(
        "validator_rejected",
        "the target's validator rejected a written family",
        fields,
        human,
      );
    }
    return { exitCode: 0, fields, human };
  },
});
