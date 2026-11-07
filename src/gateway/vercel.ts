import { createGateway, generateImage, generateText } from "ai";
import type {
  GenerationProvider,
  ImageRequest,
  ImageResult,
  VisionRequest,
  VisionResult,
} from "./provider.ts";

type Gateway = ReturnType<typeof createGateway>;
type Metadata = Record<string, Record<string, unknown> | undefined> | undefined;

function toNumber(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function gatewayMeta(metadata: Metadata): Record<string, unknown> {
  return metadata?.["gateway"] ?? {};
}

function requestId(...candidates: unknown[]): {
  requestId: string;
  requestIdSource: "provider" | "local";
} {
  for (const c of candidates) {
    if (typeof c === "string" && c !== "") return { requestId: c, requestIdSource: "provider" };
  }
  return {
    requestId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    requestIdSource: "local",
  };
}

/**
 * The Vercel AI Gateway adapter, the only place that touches the `ai` SDK.
 *
 * Request ID, in order of preference: the gateway generation ID from provider metadata, the
 * `x-vercel-id` response header (images) or the response ID (vision), else a generated
 * `local-<timestamp>-<random>` with `requestIdSource: "local"`, so provenance always has one and
 * never passes it off as the provider's. Cost is the gateway's reported
 * `cost` (USD) from provider metadata, left unset when the gateway does not report one.
 */
export class VercelGateway implements GenerationProvider {
  readonly #gateway: Gateway;

  constructor(options: { apiKey: string }) {
    this.#gateway = createGateway({ apiKey: options.apiKey });
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): VercelGateway {
    const apiKey = env["AI_GATEWAY_API_KEY"];
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        "AI_GATEWAY_API_KEY is not set; the gateway key must come from the environment",
      );
    }
    return new VercelGateway({ apiKey });
  }

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    const result = await generateImage({
      model: this.#gateway.imageModel(req.model),
      prompt:
        req.references.length === 0
          ? req.prompt
          : { text: req.prompt, images: req.references.map((r) => r.bytes) },
      ...(req.size !== undefined && { size: req.size as `${number}x${number}` }),
      ...(req.seed !== undefined && { seed: req.seed }),
      ...(req.providerOptions !== undefined && {
        providerOptions: req.providerOptions as Record<string, never>,
      }),
    });
    const meta = result.providerMetadata as Metadata;
    const gw = gatewayMeta(meta);
    const seed =
      toNumber(gw["seed"]) ??
      Object.values(meta ?? {})
        .map((entry) => toNumber(entry?.["seed"]))
        .find((s) => s !== undefined);
    const cost = toNumber(gw["cost"]);
    return {
      images: result.images.map((i) => ({ mediaType: i.mediaType, bytes: i.uint8Array })),
      ...requestId(gw["generationId"], result.responses[0]?.headers?.["x-vercel-id"]),
      ...(cost !== undefined && { costUsd: cost }),
      ...(seed !== undefined && { seed }),
    };
  }

  async analyzeImages(req: VisionRequest): Promise<VisionResult> {
    const result = await generateText({
      model: this.#gateway.languageModel(req.model),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: req.prompt },
            ...req.images.map((i) => ({
              type: "image" as const,
              image: i.bytes,
              mediaType: i.mediaType,
            })),
          ],
        },
      ],
    });
    const gw = gatewayMeta(result.providerMetadata as Metadata);
    const cost = toNumber(gw["cost"]);
    return {
      text: result.text,
      ...requestId(gw["generationId"], result.response.id),
      ...(cost !== undefined && { costUsd: cost }),
    };
  }
}
