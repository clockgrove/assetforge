import { InputError } from "../errors.ts";
import { declarationOption, profileContext } from "../inputs.ts";
import { parseRecipe, transformFiles } from "../transform/run.ts";
import type { TransformFilesOptions } from "../transform/run.ts";
import { defineCommand } from "./types.ts";
import type { Outcome } from "./types.ts";

/** Runs a recipe over input files with the style and frame size of an optional profile. */
export async function runTransform(
  options: Pick<TransformFilesOptions, "recipe" | "inputs" | "out" | "digitalSourceType">,
  profilePath: string | undefined,
): Promise<Outcome> {
  const { record, provenancePath } = await transformFiles({
    ...options,
    ...(await profileContext(profilePath)),
  });
  const lines = record.outputs.map((o) => `wrote ${o.path}`);
  lines.push(`provenance ${provenancePath}`);
  for (const o of record.outputs) {
    const checks = (o.meta?.["checks"] ?? []) as {
      check: string;
      passed: boolean;
      reason: string;
    }[];
    for (const c of checks.filter((c) => !c.passed)) {
      lines.push(`${o.name} ${c.check}: ${c.reason}`);
    }
  }
  return { exitCode: 0, fields: { provenancePath, ...record }, human: lines.join("\n") };
}

interface OpArgs {
  operation?: string;
  inputs?: string[];
  out: string;
  params?: string;
  profile?: string;
  digitalSourceType?: string;
}

export const opCommand = defineCommand<OpArgs>({
  name: "op",
  tool: null,
  summary: "run one media operation over images (matte, trim, scale, convert, ...)",
  details: `Runs one operation (see \`assetgrove ops\`) over the input images and writes the outputs and a
provenance record. --out is a file for a single output, otherwise a directory.
--profile supplies the style and frame size. Example: assetgrove op matte in.png --out out.png`,
  input: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: "the operation to run",
        placeholder: "<operation>",
      },
      inputs: {
        type: "array",
        items: { type: "string" },
        description: "the input images",
        placeholder: "<input>",
      },
      out: {
        type: "string",
        description: "where to write: a file for one output, otherwise a directory",
        placeholder: "<path>",
      },
      params: {
        type: "string",
        description: "the operation's parameters",
        placeholder: "<json object>",
      },
      profile: {
        type: "string",
        description: "the target profile that supplies the style and frame size",
        placeholder: "<profile.json>",
      },
      digitalSourceType: {
        type: "string",
        description: "the IPTC digital source type to declare",
        placeholder: "<IPTC code or URI>",
      },
    },
    required: ["out"],
    additionalProperties: false,
  },
  positionals: [{ name: "operation" }, { name: "inputs", variadic: true }],
  effect: { readOnly: false, spends: "never", writes: "out" },
  async run(args) {
    const operation = args.operation;
    const inputs = args.inputs ?? [];
    if (operation === undefined) throw new InputError("missing the operation name");
    if (inputs.length === 0) throw new InputError("missing input image(s)");
    let params: unknown = {};
    if (args.params !== undefined) {
      try {
        params = JSON.parse(args.params);
      } catch (error) {
        throw new InputError(`--params is not valid JSON: ${(error as Error).message}`, {
          cause: error,
        });
      }
      if (typeof params !== "object" || params === null || Array.isArray(params)) {
        throw new InputError("--params must be a JSON object");
      }
    }
    const recipe = parseRecipe({ steps: [{ op: operation, params }] });
    const digitalSourceType = declarationOption(args.digitalSourceType);
    return runTransform(
      { recipe, inputs, out: args.out, ...(digitalSourceType && { digitalSourceType }) },
      args.profile,
    );
  },
});
