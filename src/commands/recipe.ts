import { InputError } from "../errors.ts";
import { declarationOption, readJson } from "../inputs.ts";
import { parseRecipe } from "../transform/run.ts";
import { runTransform } from "./op.ts";
import { defineCommand } from "./types.ts";

interface RecipeArgs {
  recipe?: string;
  inputs?: string[];
  out: string;
  profile?: string;
  digitalSourceType?: string;
}

export const recipeCommand = defineCommand<RecipeArgs>({
  name: "recipe",
  tool: null,
  summary: "run a recipe file (a sequence of operations) over images",
  details: `Runs the steps of a recipe file in order over the input images and writes the outputs and a
provenance record. --out is a file for a single output, otherwise a directory.`,
  input: {
    type: "object",
    properties: {
      recipe: { type: "string", description: "the recipe file", placeholder: "<recipe.json>" },
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
  positionals: [{ name: "recipe" }, { name: "inputs", variadic: true }],
  effect: { readOnly: false, spends: "never", writes: "out" },
  async run(args) {
    const inputs = args.inputs ?? [];
    if (args.recipe === undefined) throw new InputError("missing the recipe file");
    if (inputs.length === 0) throw new InputError("missing input image(s)");
    const recipe = parseRecipe((await readJson<unknown>(args.recipe)).value);
    const digitalSourceType = declarationOption(args.digitalSourceType);
    return runTransform(
      { recipe, inputs, out: args.out, ...(digitalSourceType && { digitalSourceType }) },
      args.profile,
    );
  },
});
