import { InputError } from "./errors.ts";
import { parseJsonFile } from "./json.ts";

/** A model route: which gateway model serves an operation, its per-call estimate and its terms. */
export interface Route {
  model: string;
  /** Upper estimate of one call's cost in USD; reserved against the cap before the call. */
  estimatedCostUsd: number;
  /** The provider terms the output was made under, recorded in provenance. */
  providerTerms: string;
  size?: string;
  /** Whether the model accepts a seed; only then is one sent and recorded. */
  supportsSeed?: boolean;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface Routes {
  /** Text-and-reference stills and key poses. */
  still: Route;
  /** Reference-guided edits: each animation frame is an edit of the key pose. */
  edit: Route;
  /** Vision QA, and the grouping proposal of an imported sheet. */
  vision: Route;
  /** A whole animation cycle as one contact sheet. */
  sheet: Route;
  /** Identity scoring: a typed decision model compares a candidate with an identity record. */
  identity: Route;
  /** Identity-flicker judgement between consecutive animation frames. */
  flicker: Route;
  /** Whether a see-through area inside an animation frame's outline is a hole or an opening. */
  holes: Route;
  [operation: string]: Route;
}

/** Defaults from the gateway survey of 2026-11-07 (docs/models.md). */
export const defaultRoutes: Routes = {
  still: {
    model: "openai/gpt-image-2",
    estimatedCostUsd: 0.25,
    size: "1024x1024",
    providerTerms:
      "OpenAI Services Agreement and Usage Policies, via Vercel AI Gateway (as of 2026-11-07)",
  },
  edit: {
    model: "bfl/flux-kontext-pro",
    estimatedCostUsd: 0.05,
    supportsSeed: true,
    providerTerms:
      "Black Forest Labs API Terms of Service, via Vercel AI Gateway (as of 2026-11-07)",
  },
  sheet: {
    model: "openai/gpt-image-2",
    estimatedCostUsd: 0.3,
    size: "1536x1024",
    providerTerms:
      "OpenAI Services Agreement and Usage Policies, via Vercel AI Gateway (as of 2026-11-07)",
  },
  vision: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    providerTerms:
      "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-07)",
  },
  identity: {
    // #27's image eval: best on identity with reference images; `openai/gpt-6-luna-decisions`
    // is the alternate. About $0.00003 per answer; the estimate is a deliberate upper bound.
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-08)",
  },
  // Identity-flicker judgement between consecutive animation frames.
  flicker: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    providerTerms:
      "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-07)",
  },
  // Holes: one enlarged frame with its enclosed see-through areas marked. About $0.003 a call
  // (#51's proof); the estimate is an upper bound.
  holes: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.01,
    providerTerms:
      "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-09)",
  },
};

/** Loads a JSON file of route overrides and merges it over the defaults. */
export async function loadRoutes(path?: string): Promise<Routes> {
  if (!path) return defaultRoutes;
  const overrides = await parseJsonFile(path, "routes");
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
    throw new InputError(`routes ${path} must be a JSON object of operation to route`);
  }
  const merged: Record<string, Route> = { ...defaultRoutes };
  for (const [operation, route] of Object.entries(overrides as Record<string, Partial<Route>>)) {
    merged[operation] = { ...merged[operation], ...route } as Route;
  }
  return merged as Routes;
}
