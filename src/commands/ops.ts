import { describeOperations } from "../transform/run.ts";
import { defineCommand } from "./types.ts";

export const opsCommand = defineCommand<Record<string, never>>({
  name: "ops",
  tool: null,
  summary: "list the media operations and the engines that implement them",
  details: "Lists every operation with its summary, parameters and engines.",
  input: { type: "object", properties: {}, additionalProperties: false },
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run() {
    const described = describeOperations();
    const width = Math.max(...described.operations.map((o) => o.name.length));
    const lines = described.operations.map((o) => `${o.name.padEnd(width)}  ${o.summary}`);
    lines.push("", ...described.engines.map((e) => `engine ${e.name} ${e.version}`));
    return { exitCode: 0, fields: { ...described }, human: lines.join("\n") };
  },
});
