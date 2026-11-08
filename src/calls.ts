import type { Budget } from "./budget.ts";
import { InputError, ProviderError } from "./errors.ts";
import type {
  DecisionQuestion,
  DecisionResult,
  GenerationProvider,
  ImageInput,
  ProviderResult,
} from "./gateway/provider.ts";
import type { Route, Routes } from "./routes.ts";
import type { CallRecord, DecisionLog, LoadedReference } from "./types.ts";

/**
 * Budgeted, recorded provider calls. Each call reserves its route's estimate against the run's cap
 * before it reaches the provider, then settles with the provider's reported cost (or the estimate)
 * and appends a provenance record.
 */
export class Caller {
  readonly records: CallRecord[] = [];
  private readonly provider: GenerationProvider;
  private readonly providerName: string;
  private readonly budget: Budget;
  private readonly routes: Routes;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: {
    provider: GenerationProvider;
    providerName: string;
    budget: Budget;
    routes: Routes;
    now?: () => Date;
    /** Receives one line per typed decision call: label, confidence, latency and cost. */
    log?: (message: string) => void;
  }) {
    this.provider = options.provider;
    this.providerName = options.providerName;
    this.budget = options.budget;
    this.routes = options.routes;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  route(operation: string): Route {
    const route = this.routes[operation];
    if (!route) throw new InputError(`no model route for operation "${operation}"`);
    return route;
  }

  private async record<T extends ProviderResult>(
    operation: string,
    prompt: string,
    references: LoadedReference[],
    parameters: Record<string, unknown>,
    seed: number | undefined,
    run: (route: Route) => Promise<T>,
  ): Promise<T> {
    const route = this.route(operation);
    const reservation = this.budget.reserve(route.estimatedCostUsd, `the ${operation} call`);
    const startedAt = this.now().toISOString();
    let result: T;
    try {
      result = await run(route);
    } catch (error) {
      // A failed call may still have been billed; count the estimate so the cap stays safe.
      this.budget.settle(reservation, route.estimatedCostUsd);
      if (error instanceof ProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderError(`the ${operation} call failed: ${message}`, { cause: error });
    }
    const costUsd = result.costUsd ?? route.estimatedCostUsd;
    this.budget.settle(reservation, costUsd);
    const usedSeed = result.seed ?? seed;
    this.records.push({
      operation,
      model: route.model,
      route: `${this.providerName}:${operation}:${route.model}`,
      prompt,
      parameters,
      referenceHashes: references.map((r) => r.sha256),
      ...(usedSeed !== undefined && { seed: usedSeed }),
      requestId: result.requestId,
      requestIdSource: result.requestIdSource ?? "provider",
      startedAt,
      finishedAt: this.now().toISOString(),
      costUsd,
      costSource: result.costUsd === undefined ? "estimate" : "provider",
      providerTerms: route.providerTerms,
    });
    return result;
  }

  /** An image generation or reference-guided edit; references are sent in order. */
  async image(
    operation: string,
    prompt: string,
    references: LoadedReference[],
    seed?: number,
  ): Promise<ImageInput> {
    const route = this.route(operation);
    const sendSeed = route.supportsSeed ? seed : undefined;
    const parameters: Record<string, unknown> = {
      ...(route.size !== undefined && { size: route.size }),
      ...(sendSeed !== undefined && { seed: sendSeed }),
      ...(route.providerOptions !== undefined && { providerOptions: route.providerOptions }),
      references: references.map((r) => ({ role: r.role, path: r.path, sha256: r.sha256 })),
    };
    const result = await this.record(operation, prompt, references, parameters, sendSeed, (r) =>
      this.provider.generateImage({
        model: r.model,
        prompt,
        references: references.map((ref) => ({ mediaType: ref.mediaType, bytes: ref.bytes })),
        ...(r.size !== undefined && { size: r.size }),
        ...(sendSeed !== undefined && { seed: sendSeed }),
        ...(r.providerOptions !== undefined && { providerOptions: r.providerOptions }),
      }),
    );
    const image = result.images[0];
    if (!image) throw new ProviderError(`the ${operation} call returned no image`);
    return image;
  }

  /** A vision-model analysis of images; returns the model's text. */
  async vision(operation: string, prompt: string, images: LoadedReference[]): Promise<string> {
    const parameters = {
      images: images.map((r) => ({ role: r.role, path: r.path, sha256: r.sha256 })),
    };
    const result = await this.record(operation, prompt, images, parameters, undefined, (r) =>
      this.provider.analyzeImages({
        model: r.model,
        prompt,
        images: images.map((ref) => ({ mediaType: ref.mediaType, bytes: ref.bytes })),
      }),
    );
    return result.text;
  }

  /**
   * A typed decision (Score or Boolean) about images. The call record carries the decision's
   * label, normalised value, confidence and latency, and one log line reports them with the cost.
   */
  async decide(
    operation: string,
    prompt: string,
    images: LoadedReference[],
    question: DecisionQuestion,
  ): Promise<{ result: DecisionResult; record: CallRecord }> {
    const parameters = {
      question,
      images: images.map((r) => ({ role: r.role, path: r.path, sha256: r.sha256 })),
    };
    const started = performance.now();
    const result = await this.record(operation, prompt, images, parameters, undefined, (r) => {
      const decide = this.provider.decide?.bind(this.provider);
      if (!decide)
        throw new ProviderError(`the provider cannot make typed decisions (${operation})`);
      return decide({
        model: r.model,
        prompt,
        images: images.map((ref) => ({ mediaType: ref.mediaType, bytes: ref.bytes })),
        question,
      });
    });
    const record = this.records[this.records.length - 1] as CallRecord;
    record.decision = decisionLog(question, result, Math.round(performance.now() - started));
    const d = record.decision;
    this.log(
      `${operation} ${record.model}: ${d.label} (value ${d.value.toFixed(3)}` +
        `${d.confidence !== undefined ? `, confidence ${d.confidence.toFixed(2)}` : ""}` +
        `, ${d.latencyMs} ms, $${record.costUsd.toFixed(6)} ${record.costSource})`,
    );
    return { result, record };
  }
}

function decisionLog(
  question: DecisionQuestion,
  result: DecisionResult,
  latencyMs: number,
): DecisionLog {
  const { answer } = result;
  if (question.type === "score" && answer.type === "score") {
    const top = Math.max(1, question.levels.length - 1);
    const level = Math.min(top, Math.max(0, Math.round(answer.score)));
    const levelProbability = answer.probabilities?.[String(level)];
    const confidence = result.confidence ?? levelProbability;
    return {
      question: "score",
      label: question.levels[level] ?? String(level),
      value: Math.min(1, Math.max(0, answer.score / top)),
      raw: answer.score,
      ...(confidence !== undefined && { confidence }),
      latencyMs,
    };
  }
  if (question.type === "boolean" && answer.type === "boolean") {
    return {
      question: "boolean",
      label: answer.probability >= 0.5 ? "true" : "false",
      value: Math.min(1, Math.max(0, answer.probability)),
      raw: answer.probability,
      ...(result.confidence !== undefined && { confidence: result.confidence }),
      latencyMs,
    };
  }
  throw new ProviderError(`the decision answer is a ${answer.type}, not a ${question.type}`);
}
