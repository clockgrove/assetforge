/**
 * The generation provider interface Assetgrove owns. The gateway adapter implements it; the
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
  /** The route's provider options, passed to the provider as given. */
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface VisionResult extends ProviderResult {
  text: string;
}

export interface GenerationProvider {
  generateImage(request: ImageRequest): Promise<ImageResult>;
  analyzeImages(request: VisionRequest): Promise<VisionResult>;
  /** A typed decision (Score or Boolean); providers without decision models leave it out. */
  decide?(request: DecisionRequest): Promise<DecisionResult>;
  /** Image-to-3D: a textured model from reference images. Providers without 3D leave it out. */
  generateModel?(request: ModelRequest): Promise<ModelResult>;
  /** Rigs a model the provider made earlier (by its handle) for a gait. */
  rigModel?(request: RigRequest): Promise<ModelResult>;
  /** Retargets library clips onto a rigged model (by its handle); one model with every clip. */
  animateModel?(request: AnimateRequest): Promise<ModelResult>;
}

/** Reference views for image-to-3D, by the view each image shows. */
export interface ModelView extends ImageInput {
  /** `front`, `left`, `back`, `right`, or another role when the view is unknown. */
  view: string;
}

export interface ModelRequest {
  model: string;
  /** Reference images; with several named views the provider may build from all of them. */
  views: ModelView[];
  prompt?: string;
  seed?: number;
  /** The target's triangle budget; a provider that can limit its mesh should stay within it. */
  maxTriangles?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface RigRequest {
  model: string;
  /** The provider's handle of the model to rig. */
  source: string;
  /** The rig the provider fits, for example `quadruped` or `biped`. */
  rigType: string;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface AnimateRequest {
  model: string;
  /** The provider's handle of the rigged model. */
  source: string;
  /** Library clip IDs, in order; the result holds one animation per clip, in this order. */
  clips: string[];
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface ModelResult extends ProviderResult {
  /** An opaque handle a later call (rig, animate) passes back to the same provider. */
  handle: string;
  /** The model as binary glTF. */
  glb: Uint8Array;
}

/**
 * A typed decision question. `score` asks for a position on ordered levels (indexed from zero);
 * `boolean` asks for the probability that the statement is true.
 */
export type DecisionQuestion =
  | { type: "score"; instructions: string; levels: string[] }
  | { type: "boolean"; instructions: string; whenTrue?: string; whenFalse?: string };

export interface DecisionRequest {
  model: string;
  /** Text state given before the images. */
  prompt: string;
  /** Images, in the order the prompt names them. */
  images: ImageInput[];
  question: DecisionQuestion;
}

export type DecisionAnswer =
  | {
      type: "score";
      /** Fractional position in `[0, levels.length - 1]`. */
      score: number;
      /** Probability per level index, when the model reports a distribution. */
      probabilities?: Record<string, number>;
    }
  | {
      type: "boolean";
      /** The model's probability that the statement is true. */
      probability: number;
    };

export interface DecisionResult extends ProviderResult {
  answer: DecisionAnswer;
  /** The provider's own confidence statistic for the answer, when it reports one. */
  confidence?: number;
}
