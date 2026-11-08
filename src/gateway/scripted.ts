import type {
  DecisionRequest,
  DecisionResult,
  GenerationProvider,
  ImageRequest,
  ImageResult,
  VisionRequest,
  VisionResult,
} from "./provider.ts";

/**
 * A scripted generation provider for tests and offline runs. It never calls a model: each call is
 * answered by the script, and every request is kept in `calls` so tests can inspect it.
 */
export interface Script {
  image(
    request: ImageRequest,
    index: number,
  ): Omit<ImageResult, "requestId"> & { requestId?: string };
  vision(
    request: VisionRequest,
    index: number,
  ): Omit<VisionResult, "requestId"> & { requestId?: string };
  /** Answers typed decision calls; a script without it cannot answer one. */
  decide?(
    request: DecisionRequest,
    index: number,
  ): Omit<DecisionResult, "requestId"> & { requestId?: string };
}

export class ScriptedProvider implements GenerationProvider {
  readonly calls: Array<
    | { kind: "image"; request: ImageRequest }
    | { kind: "vision"; request: VisionRequest }
    | { kind: "decide"; request: DecisionRequest }
  > = [];
  private readonly script: Script;
  private imageCount = 0;
  private visionCount = 0;
  private decideCount = 0;

  constructor(script: Script) {
    this.script = script;
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    this.calls.push({ kind: "image", request });
    const index = this.imageCount++;
    const result = this.script.image(request, index);
    return { requestId: `scripted-image-${index}`, ...result };
  }

  async analyzeImages(request: VisionRequest): Promise<VisionResult> {
    this.calls.push({ kind: "vision", request });
    const index = this.visionCount++;
    const result = this.script.vision(request, index);
    return { requestId: `scripted-vision-${index}`, ...result };
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    this.calls.push({ kind: "decide", request });
    const index = this.decideCount++;
    if (!this.script.decide) throw new Error("the provider script has no decide answer");
    const result = this.script.decide(request, index);
    return { requestId: `scripted-decide-${index}`, ...result };
  }
}
