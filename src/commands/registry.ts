import { animationQaCommand } from "./animation-qa.ts";
import { applyCommand } from "./apply.ts";
import { bibleCommand } from "./bible.ts";
import { fixFrameCommand } from "./fix-frame.ts";
import { generateSheetCommand } from "./generate-sheet.ts";
import { identityCheckCommand } from "./identity-check.ts";
import { identityEvalCommand } from "./identity-eval.ts";
import { importCommand } from "./import.ts";
import { lodCommand } from "./lod.ts";
import { lookDevCommand } from "./look-dev.ts";
import { materialsCommand } from "./materials.ts";
import { mcpCommand } from "./mcp.ts";
import { opCommand } from "./op.ts";
import { opsCommand } from "./ops.ts";
import { pickCommand } from "./pick.ts";
import { planCommand } from "./plan.ts";
import { recipeCommand } from "./recipe.ts";
import { rigCommand } from "./rig.ts";
import { stageCommand } from "./stage.ts";
import type { CommandSpec } from "./types.ts";
import { writeFamiliesCommand } from "./write-families.ts";

/** Every command, declared once, in the order help lists them. */
export const commands: readonly CommandSpec[] = [
  bibleCommand,
  planCommand,
  applyCommand,
  mcpCommand,
  materialsCommand,
  stageCommand,
  pickCommand,
  rigCommand,
  lodCommand,
  lookDevCommand,
  importCommand,
  generateSheetCommand,
  writeFamiliesCommand,
  identityEvalCommand,
  identityCheckCommand,
  animationQaCommand,
  fixFrameCommand,
  opCommand,
  recipeCommand,
  opsCommand,
];

/** The name of every registry command. */
export const commandNames: readonly string[] = commands.map((c) => c.name);
