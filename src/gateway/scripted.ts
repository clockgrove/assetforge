import type {
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
  image(request: ImageRequest, index: number): Omit<ImageResult, "requestId"> & { requestId?: string };
  vision(request: VisionRequest, index: number): Omit<VisionResult, "requestId"> & { requestId?: string };
}

export class ScriptedProvider implements GenerationProvider {
  readonly calls: Array<
    { kind: "image"; request: ImageRequest } | { kind: "vision"; request: VisionRequest }
  > = [];
  private readonly script: Script;
  private imageCount = 0;
  private visionCount = 0;

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
}
