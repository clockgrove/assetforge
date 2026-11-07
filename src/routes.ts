import { readFile } from "node:fs/promises";

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
};

/** Loads a JSON file of route overrides and merges it over the defaults. */
export async function loadRoutes(path?: string): Promise<Routes> {
  if (!path) return defaultRoutes;
  const overrides = JSON.parse(await readFile(path, "utf8")) as Record<string, Partial<Route>>;
  const merged: Record<string, Route> = { ...defaultRoutes };
  for (const [operation, route] of Object.entries(overrides)) {
    merged[operation] = { ...merged[operation], ...route } as Route;
  }
  return merged as Routes;
}
