// The part of Clockgrove's packages/contracts/src/asset-manifest.ts that model-asset.ts imports,
// taken from the same commit (see ./README.md). The types are copied as they are; the 2D manifest
// decoder is not vendored, because only model manifests are validated here.

export interface AssetOutputGrant {
  readonly license?: string;
  readonly plan?: string;
  readonly commercial?: boolean;
  readonly relabel?: boolean;
  readonly attribution?: string;
}
export interface AssetProvenance {
  readonly prompt: string | null;
  readonly references: readonly string[];
  readonly model?: string;
  readonly provider?: string;
  readonly route?: string;
  readonly providerTermsVersion?: string;
  readonly outputGrant?: AssetOutputGrant;
}

export interface AssetManifest {
  readonly assetManifestVersion: 2;
  readonly assetId: string;
  readonly source: {
    readonly kind: "generated" | "authored" | "imported";
    readonly path: string;
    readonly creator: string;
    readonly tool: string | null;
  };
  readonly license: string;
  readonly provenance: AssetProvenance;
  readonly review: {
    readonly status: "pending" | "approved" | "rejected";
    readonly reviewer: string | null;
    readonly reviewedAt: string | null;
    readonly notes: string;
  };
  readonly semantic: {
    readonly role: "actor" | "object" | "terrain" | "effect";
    readonly entity: string | null;
    readonly archetype: string | null;
  };
  readonly accessibilityLabel: string;
}

export function decodeAssetManifest(_value: unknown, path = "manifest"): AssetManifest {
  throw new Error(`${path}: the 2D asset manifest decoder is not vendored`);
}
