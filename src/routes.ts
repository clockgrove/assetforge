import { InputError } from "./errors.ts";
import { parseJsonFile } from "./json.ts";
import { requireGrant } from "./license.ts";
import type { OutputGrant } from "./types.ts";

export const IDENTITY_CAST_OPERATION = "identity-cast";
export const LOOKDEV_OPERATION = "lookdev";
export const LOOKDEV_LOCATE_OPERATION = "lookdev-locate";
export const LOOKDEV_GROOM_OPERATION = "lookdev-groom";
export const LOOKDEV_MARKINGS_OPERATION = "lookdev-markings";
export const IDENTITY_CHECK_OPERATION = "identity-check";

/** A model route: which gateway model serves an operation, its per-call estimate and its terms. */
export interface Route {
  model: string;
  /** Upper estimate of one call's cost in USD; reserved against the cap before the call. */
  estimatedCostUsd: number;
  /** The provider terms the output was made under, recorded in provenance. */
  providerTerms: string;
  /**
   * What the provider grants for this route's outputs on the plan it is called on, recorded on
   * every call. A route to a provider whose terms do not give ownership (a free plan) must
   * declare it, or its outputs are taken as relabellable (docs/generation-knobs.md).
   */
  outputGrant?: OutputGrant;
  size?: string;
  /** Whether the model accepts a seed; only then is one sent and recorded. */
  supportsSeed?: boolean;
  providerOptions?: Record<string, Record<string, unknown>>;
  /**
   * 3D routes: the axis the provider's models face (`+z` when unset). Assetgrove turns each model
   * to the target profile's `model3d.forward`.
   */
  forward?: "+x" | "-x" | "+z" | "-z";
  /**
   * 3D clip routes: the provider's animation library, by gait then family: the library clip that
   * is retargeted for the family and whether the family loops. A family not listed has no close
   * library clip and is reported as missing.
   */
  library?: Record<string, Record<string, { clip: string; loop: boolean }>>;
  /** 3D rig routes: the provider's rig type for each gait (the gait itself when unlisted). */
  rigTypes?: Record<string, string>;
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
  /** Image-to-3D: a textured character model from the approved turnaround. */
  model3d: Route;
  /** The provider's auto-rig for the spec's gait. */
  rig3d: Route;
  /** Library clips retargeted onto the rig, one per requested family, in one call. */
  clips3d: Route;
  [operation: string]: Route;
}

/**
 * Tripo on paid credits: the account owns its outputs, so they ship under the target's licence
 * (owner decision on #72). Credits are about $0.01 each.
 */
const tripoGrant = {
  license: "LicenseRef-tripo-paid",
  plan: "paid",
  commercial: true,
  relabel: true,
};
const tripoTerms = "Tripo API Terms of Service, paid credits (as of 2026-11-10)";

/** Defaults from the gateway survey of 2026-11-07 (docs/models.md). */
export const defaultRoutes: Routes = {
  still: {
    model: "openai/gpt-image-2",
    estimatedCostUsd: 0.25,
    size: "1024x1024",
    outputGrant: {
      license: "LicenseRef-openai-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "OpenAI Services Agreement and Usage Policies, via Vercel AI Gateway (as of 2026-11-07)",
  },
  edit: {
    model: "bfl/flux-kontext-pro",
    estimatedCostUsd: 0.05,
    supportsSeed: true,
    outputGrant: {
      license: "LicenseRef-bfl-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "Black Forest Labs API Terms of Service, via Vercel AI Gateway (as of 2026-11-07)",
  },
  sheet: {
    model: "openai/gpt-image-2",
    estimatedCostUsd: 0.3,
    size: "1536x1024",
    outputGrant: {
      license: "LicenseRef-openai-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "OpenAI Services Agreement and Usage Policies, via Vercel AI Gateway (as of 2026-11-07)",
  },
  vision: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    outputGrant: {
      license: "LicenseRef-google-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-07)",
  },
  identity: {
    // #27's image eval: best on identity with reference images; `openai/gpt-6-luna-decisions`
    // is the alternate. About $0.00003 per answer; the estimate is a deliberate upper bound.
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-08)",
  },
  // Identity as a choice among the whole cast's references (#92): one vision call per candidate.
  [IDENTITY_CAST_OPERATION]: {
    model: "openai/gpt-6.1-terra",
    estimatedCostUsd: 0.02,
    outputGrant: {
      license: "LicenseRef-openai-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "OpenAI Services Agreement and Usage Policies, via Vercel AI Gateway (as of 2026-11-11)",
  },
  // Whether an identity record's written signature agrees with its own approved references (#92).
  [IDENTITY_CHECK_OPERATION]: {
    model: "openai/gpt-6.1-terra",
    estimatedCostUsd: 0.02,
    outputGrant: {
      license: "LicenseRef-openai-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "OpenAI Services Agreement and Usage Policies, via Vercel AI Gateway (as of 2026-11-11)",
  },
  // Identity-flicker judgement between consecutive animation frames.
  flicker: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    outputGrant: {
      license: "LicenseRef-google-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-07)",
  },
  // Image-to-3D on Tripo: multiview (or single-image) to a textured PBR model, 30 credits with
  // texture and PBR (#72's probe); the estimate is an upper bound. Its models face +x: measured
  // on a real run (#72), head at +x in the raw multiview output and after the rig.
  model3d: {
    model: "tripo/v2.5-20250123",
    estimatedCostUsd: 0.5,
    forward: "+x",
    outputGrant: tripoGrant,
    providerTerms: tripoTerms,
    providerOptions: {
      tripo: { modelVersion: "v2.5-20250123", texture: true, pbr: true, usdPerCredit: 0.01 },
    },
  },
  // Tripo's auto-rig, 25 credits (#72's probe). Quadruped rigs need the v2 rigger; v1 refuses them.
  rig3d: {
    model: "tripo/animate-rig-v2.0-20250506",
    estimatedCostUsd: 0.3,
    outputGrant: tripoGrant,
    providerTerms: tripoTerms,
    rigTypes: { quadruped: "quadruped", biped: "biped" },
    providerOptions: {
      tripo: { spec: "tripo", modelVersion: "v2.0-20250506", usdPerCredit: 0.01 },
    },
  },
  // Tripo's animation library retargeted onto the rig.
  clips3d: {
    model: "tripo/animate-retarget",
    estimatedCostUsd: 0.2,
    outputGrant: tripoGrant,
    providerTerms: tripoTerms,
    library: {
      biped: {
        idle: { clip: "preset:idle", loop: true },
        walk: { clip: "preset:walk", loop: true },
        run: { clip: "preset:run", loop: true },
        jump: { clip: "preset:jump", loop: false },
        turn: { clip: "preset:turn", loop: false },
        hurt: { clip: "preset:hurt", loop: false },
        fall: { clip: "preset:fall", loop: false },
        climb: { clip: "preset:climb", loop: false },
        dive: { clip: "preset:dive", loop: false },
        slash: { clip: "preset:slash", loop: false },
        shoot: { clip: "preset:shoot", loop: false },
      },
      // Tripo's library has one quadruped clip (probed 2026-11-10: `preset:quadruped:idle`,
      // `:run`, `:trot` and others are refused as invalid animation names).
      quadruped: {
        walk: { clip: "preset:quadruped:walk", loop: true },
      },
    },
    providerOptions: { tripo: { usdPerCredit: 0.01 } },
  },
  // Look-dev (#82): each flat-lit render of a picked 3D character repainted in the look its
  // approved references and the bible define, then projected back onto the model's own UVs.
  [LOOKDEV_OPERATION]: {
    model: "openai/gpt-image-2",
    estimatedCostUsd: 0.25,
    size: "1024x1024",
    outputGrant: {
      license: "LicenseRef-openai-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "OpenAI Services Agreement and Usage Policies, via Vercel AI Gateway (as of 2026-11-07)",
  },
  // Look-dev (#82): where the eyes and nose are on a close-up render, as pixel points and radii.
  [LOOKDEV_LOCATE_OPERATION]: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    outputGrant: {
      license: "LicenseRef-google-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-07)",
  },
  // Look-dev (#82): one season's groom (lengths, densities, tip tint) read from the target's traits.
  [LOOKDEV_GROOM_OPERATION]: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    outputGrant: {
      license: "LicenseRef-google-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-07)",
  },
  // Look-dev (#122): where each identity marking and the coat beside it are, in a turnaround view
  // and the lit renders of the same view, for the deterministic markings check.
  // Low thinking (assetgrove#122): boxing markings needs no long reasoning, and at the default
  // level the call ran long enough to time out at the gateway relay in two real runs.
  [LOOKDEV_MARKINGS_OPERATION]: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } },
    outputGrant: {
      license: "LicenseRef-google-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-12)",
  },
  // Holes: one enlarged frame with its enclosed see-through areas marked. $0.003 to $0.008 a call
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
    const grant = merged[operation]?.outputGrant;
    if (grant !== undefined) requireGrant(grant, `the ${operation} route in ${path}`);
  }
  return merged as Routes;
}
