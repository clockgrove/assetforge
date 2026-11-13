import { createGateway, experimental_decide, generateImage, generateText } from "ai";
import type {
  DecisionAnswer,
  DecisionRequest,
  DecisionResult,
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

  constructor(options: { apiKey: string; baseURL?: string }) {
    this.#gateway = createGateway({
      apiKey: options.apiKey,
      ...(options.baseURL !== undefined && { baseURL: options.baseURL }),
    });
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): VercelGateway {
    const apiKey = env["AI_GATEWAY_API_KEY"];
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        "AI_GATEWAY_API_KEY is not set; the gateway key must come from the environment",
      );
    }
    // Inside a Factory stage the key is a relay token: calls go through Factory's metering relay,
    // which counts them against the Objective's caps (clockgrove/factory#97). `/v4/ai` is the
    // gateway SDK's own path, so the relay sees the requests the gateway would.
    const relay = env["FACTORY_GATEWAY_URL"];
    return new VercelGateway({
      apiKey,
      ...(relay && { baseURL: `${relay.replace(/\/$/, "")}/v4/ai` }),
    });
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
      ...(req.providerOptions !== undefined && {
        providerOptions: req.providerOptions as Record<string, never>,
      }),
    });
    const gw = gatewayMeta(result.providerMetadata as Metadata);
    const cost = toNumber(gw["cost"]);
    return {
      text: result.text,
      ...requestId(gw["generationId"], result.response.id),
      ...(cost !== undefined && { costUsd: cost }),
    };
  }

  /**
   * A typed decision through the gateway's decision models. The question is always asked under
   * the ID `answer`. Confidence is the provider's own statistic from provider metadata
   * (Perplexity and TypeSafe report one per question), when it reports one.
   */
  async decide(req: DecisionRequest): Promise<DecisionResult> {
    const q = req.question;
    const question =
      q.type === "score"
        ? { type: "score" as const, instructions: q.instructions, criteria: q.levels }
        : {
            type: "boolean" as const,
            instructions: q.instructions,
            criteria: {
              ...(q.whenTrue !== undefined && { true: q.whenTrue }),
              ...(q.whenFalse !== undefined && { false: q.whenFalse }),
            },
          };
    const result = await experimental_decide({
      model: this.#gateway.decisionModel(req.model),
      state: [
        { type: "text", text: req.prompt },
        ...req.images.map((i) => ({
          type: "file" as const,
          mediaType: i.mediaType,
          data: i.bytes,
        })),
      ],
      questions: { answer: question },
      // Decision providers rate-limit tightly (#27); back off and retry rather than fail.
      maxRetries: 4,
    });
    const raw = result.answers.answer as
      | { type: "score"; score: number; probabilities?: Record<string, number> }
      | { type: "boolean"; probability: number };
    const answer: DecisionAnswer =
      raw.type === "score"
        ? {
            type: "score",
            score: raw.score,
            ...(raw.probabilities !== undefined && { probabilities: raw.probabilities }),
          }
        : { type: "boolean", probability: raw.probability };
    const meta = result.providerMetadata as Metadata;
    const confidence = Object.values(meta ?? {})
      .map((entry) => {
        const c = entry?.["confidence"];
        return toNumber(
          c !== null && typeof c === "object" ? (c as Record<string, unknown>)["answer"] : c,
        );
      })
      .find((c) => c !== undefined);
    const cost = toNumber(gatewayMeta(meta)["cost"]);
    return {
      answer,
      ...requestId(gatewayMeta(meta)["generationId"], result.response.id),
      ...(cost !== undefined && { costUsd: cost }),
      ...(confidence !== undefined && { confidence }),
    };
  }
}
