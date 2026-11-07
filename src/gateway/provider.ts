/**
 * The generation provider interface Assetforge owns. The gateway adapter implements it; the
 * scripted provider implements it for tests. No provider SDK type appears here.
 */

export interface ImageInput {
  mediaType: string;
  bytes: Uint8Array;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  /** Reference images; when present the model edits or follows them. */
  references: ImageInput[];
  size?: string;
  seed?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface ProviderResult {
  requestId: string;
  /**
   * `local` when the provider reported no request ID and the adapter generated one, so a
   * fabricated ID is never mistaken for a traceable one. Absent means the provider reported it.
   */
  requestIdSource?: "provider" | "local";
  /** The cost the provider reported, in USD, when it reports one. */
  costUsd?: number;
  /** The seed the provider used, when it reports one. */
  seed?: number;
}

export interface ImageResult extends ProviderResult {
  images: ImageInput[];
}

export interface VisionRequest {
  model: string;
  prompt: string;
  images: ImageInput[];
}

export interface VisionResult extends ProviderResult {
  text: string;
}

export interface GenerationProvider {
  generateImage(request: ImageRequest): Promise<ImageResult>;
  analyzeImages(request: VisionRequest): Promise<VisionResult>;
}
