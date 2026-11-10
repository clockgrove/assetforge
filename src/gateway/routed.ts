import { ProviderError } from "../errors.ts";
import type {
  AnimateRequest,
  DecisionRequest,
  DecisionResult,
  GenerationProvider,
  ImageRequest,
  ImageResult,
  ModelRequest,
  ModelResult,
  RigRequest,
  VisionRequest,
  VisionResult,
} from "./provider.ts";

/** An adapter that serves only the 3D calls. */
export type ModelProvider = Pick<GenerationProvider, "generateModel" | "rigModel" | "animateModel">;

/**
 * One provider made of two adapters: image, vision and decision calls go to the gateway, 3D calls
 * to the 3D adapter. Each adapter is made on its first call, so a missing key fails only the calls
 * that need it (as a provider error) and a run that never makes them needs no key for them.
 */
export class RoutedProvider implements GenerationProvider {
  private readonly makeGateway: () => GenerationProvider;
  private readonly makeModels: () => ModelProvider;
  private gateway?: GenerationProvider;
  private models?: ModelProvider;

  constructor(options: { gateway: () => GenerationProvider; models: () => ModelProvider }) {
    this.makeGateway = options.gateway;
    this.makeModels = options.models;
  }

  private image(): GenerationProvider {
    return (this.gateway ??= make(this.makeGateway));
  }

  private model(): ModelProvider {
    return (this.models ??= make(this.makeModels));
  }

  generateImage(request: ImageRequest): Promise<ImageResult> {
    return this.image().generateImage(request);
  }

  analyzeImages(request: VisionRequest): Promise<VisionResult> {
    return this.image().analyzeImages(request);
  }

  decide(request: DecisionRequest): Promise<DecisionResult> {
    const provider = this.image();
    if (!provider.decide) throw new ProviderError("the gateway cannot make typed decisions");
    return provider.decide(request);
  }

  generateModel(request: ModelRequest): Promise<ModelResult> {
    const provider = this.model();
    if (!provider.generateModel) throw new ProviderError("the 3D provider cannot make models");
    return provider.generateModel(request);
  }

  rigModel(request: RigRequest): Promise<ModelResult> {
    const provider = this.model();
    if (!provider.rigModel) throw new ProviderError("the 3D provider cannot rig models");
    return provider.rigModel(request);
  }

  animateModel(request: AnimateRequest): Promise<ModelResult> {
    const provider = this.model();
    if (!provider.animateModel) throw new ProviderError("the 3D provider cannot animate models");
    return provider.animateModel(request);
  }
}

function make<T>(factory: () => T): T {
  try {
    return factory();
  } catch (error) {
    throw new ProviderError((error as Error).message, { cause: error });
  }
}
