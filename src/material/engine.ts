import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { InputError } from "../errors.ts";
import { decodeImage, encodePng } from "../image/raster.ts";
import { sha256 } from "../request.ts";
import type {
  ImageEngine,
  ImageItem,
  OperationContext,
  OperationResult,
} from "../transform/types.ts";
import { deriveNormals, extractScalarMap } from "./core.ts";
import type { MaterialGrid } from "./core.ts";
import { downsample, checkCompressed } from "./rendition.ts";
const execute = promisify(execFile);
export interface CommandRecord {
  argv: string[];
  cwd: string;
  exitCode: number | string | null;
  stdout: string;
  stderr: string;
}
export async function targetCommand(
  argv: string[],
  values: Record<string, string>,
  cwd: string,
): Promise<CommandRecord> {
  const expanded = argv.map((arg) =>
    arg.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
      if (values[key] === undefined)
        throw new InputError(`unknown material command placeholder: ${key}`);
      return values[key];
    }),
  );
  if (!expanded.length || expanded.some((arg) => !arg))
    throw new InputError("material target command must be a nonempty argument array");
  if (values["output"]) await rm(values["output"], { force: true });
  try {
    const result = await execute(expanded[0]!, expanded.slice(1), {
      cwd,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return { argv: expanded, cwd, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const e = error as Error & { code?: string | number; stdout?: string; stderr?: string };
    Object.assign(e, {
      commandRecord: {
        argv: expanded,
        cwd,
        exitCode: e.code ?? null,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      },
    });
    throw e;
  }
}
const channels = ["normal", "height", "emissive", "roughness", "wind"] as const;
export const materialEngine: ImageEngine = {
  name: "assetforge-material",
  version: "1",
  operations: {},
  encoders: {},
  decode: decodeImage,
  asyncOperations: Object.fromEntries([
    ...channels.map(
      (channel) =>
        [
          `material-${channel}`,
          async (
            items: ImageItem[],
            params: Record<string, unknown>,
            context: OperationContext,
          ): Promise<OperationResult> => {
            const item = items[0]!;
            const grid = params["grid"] as unknown as MaterialGrid;
            const method = params["method"] as string;
            if (!(params["version"] as string).trim())
              throw new InputError("material method version required");
            let raster;
            let inputHash: string;
            if (method === "height-derived-normal") {
              if (channel !== "normal")
                throw new InputError("height-derived-normal is only valid for normals");
              raster = deriveNormals(item.raster, grid, params["strength"] as number);
              inputHash = sha256(encodePng(item.raster));
            } else {
              let bytes: Uint8Array;
              if (method === "mask-extraction") {
                if (!params["path"])
                  throw new InputError(`missing extraction source path for ${channel}`);
                bytes = new Uint8Array(await readFile(params["path"] as string));
              } else {
                if (!context.materialCall)
                  throw new InputError("model-assisted material recipe requires a budgeted Caller");
                const source = encodePng(item.raster);
                const result = await context.materialCall.image(
                  `material-${channel}`,
                  `Derive an aligned ${channel} material map. Preserve every frame pose and alpha. ${channel === "normal" ? "Encode tangent-space +Y normals in normalized RGB." : "Encode scalar grayscale [0,1]."} Only these named light sources may emit: ${(params["lightSources"] as string[]).join(", ") || "none"}. Method version: ${params["version"]}.`,
                  [
                    {
                      bytes: source,
                      mediaType: "image/png",
                      sha256: sha256(source),
                      role: "neutral-key-light albedo",
                      path: "recipe-input.png",
                    },
                  ],
                );
                bytes = result.bytes;
              }
              inputHash = sha256(bytes);
              const source = decodeImage(bytes);
              raster =
                channel === "normal"
                  ? source
                  : extractScalarMap(item.raster, source, grid, {
                      component: params["component"] as "red" | "alpha" | "luminance",
                    });
            }
            return {
              items: [{ ...item, raster, meta: { ...item.meta, channel } }],
              report: { method, version: params["version"], inputHash },
            };
          },
        ] as const,
    ),
    [
      "material-rendition",
      async (items: ImageItem[], params: Record<string, unknown>): Promise<OperationResult> => ({
        items: items.map((item) => ({
          ...item,
          name: `${item.name}@${params["scale"]}x`,
          raster: downsample(
            item.raster,
            params["grid"] as unknown as MaterialGrid,
            params["scale"] as number,
            params["native"] as number,
            params["normal"] as boolean,
          ),
        })),
      }),
    ],
    [
      "material-encode",
      async (items: ImageItem[], params: Record<string, unknown>): Promise<OperationResult> => {
        const item = items[0]!;
        const input = params["input"] as string,
          output = params["output"] as string;
        if (resolve(input) === resolve(output))
          throw new InputError("encode input and output must differ");
        await writeFile(input, encodePng(item.raster));
        const result = await targetCommand(
          params["command"] as string[],
          { input, output },
          params["cwd"] as string,
        );
        const bytes = new Uint8Array(await readFile(output));
        checkCompressed(bytes, item.raster.width, item.raster.height);
        return {
          items,
          report: {
            ...result,
            version: params["version"],
            sha256: sha256(bytes),
            path: output,
            mediaType: "image/ktx2",
          },
        };
      },
    ],
  ]) as NonNullable<ImageEngine["asyncOperations"]>,
};
