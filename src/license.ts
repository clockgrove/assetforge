/**
 * Output grants: what a provider grants for an output, and which licence the output may be declared
 * under in a target (issue #47; the field names are shared with clockgrove/clockgrove#61).
 */
import { InputError } from "./errors.ts";
import type { CallRecord, OutputGrant, Provenance, TargetProfile } from "./types.ts";

/** The target cannot declare an output under any licence its provider's terms allow. */
export class LicenseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LicenseError";
  }
}

/** Why `value` is not a valid output grant; empty when it is one. */
export function grantProblems(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["it is not a JSON object"];
  }
  const grant = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of ["license", "plan"]) {
    if (typeof grant[key] !== "string" || !(grant[key] as string).trim()) {
      problems.push(`${key} is not a non-empty string`);
    }
  }
  for (const key of ["commercial", "relabel"]) {
    if (typeof grant[key] !== "boolean") problems.push(`${key} is not true or false`);
  }
  if (grant["attribution"] !== undefined && typeof grant["attribution"] !== "string") {
    problems.push("attribution is not a string");
  }
  if (grant["relabel"] === true && grant["commercial"] === false) {
    problems.push("relabel cannot be true for a non-commercial grant");
  }
  return problems;
}

/** Throws an InputError naming what is wrong with a grant, when it is not one. */
export function requireGrant(value: unknown, label: string): OutputGrant {
  const problems = grantProblems(value);
  if (problems.length > 0) {
    throw new InputError(`invalid outputGrant of ${label}: ${problems.join("; ")}`);
  }
  return value as OutputGrant;
}

/** How restrictive a grant is: non-commercial, then attribution-only, then relabellable. */
function rank(grant: OutputGrant): number {
  if (!grant.commercial) return 2;
  return grant.relabel ? 0 : 1;
}

const distinct = (values: string[]) => [...new Set(values)];

/**
 * The combination of several grants; the most restrictive wins. `commercial` and `relabel` hold
 * only when every grant allows them; `license` is the licence of the most restrictive grants
 * (joined with ` AND ` when they differ); `plan` lists every plan, `attribution` every credit line.
 * Undefined when there is no grant.
 */
export function combineGrants(grants: OutputGrant[]): OutputGrant | undefined {
  if (grants.length === 0) return undefined;
  const worst = Math.max(...grants.map(rank));
  const attribution = distinct(grants.flatMap((g) => (g.attribution ? [g.attribution] : [])));
  return {
    license: distinct(grants.filter((g) => rank(g) === worst).map((g) => g.license)).join(" AND "),
    plan: distinct(grants.map((g) => g.plan)).join(" + "),
    commercial: grants.every((g) => g.commercial),
    relabel: grants.every((g) => g.relabel),
    ...(attribution.length > 0 && { attribution: attribution.join("; ") }),
  };
}

/** The combined grant of every call that records one. */
export function grantOf(calls: CallRecord[]): OutputGrant | undefined {
  return combineGrants(
    calls.flatMap((c, i) =>
      c.outputGrant === undefined
        ? []
        : [requireGrant(c.outputGrant, `call ${i + 1} (${c.route})`)],
    ),
  );
}

/** The licences a target accepts beyond its own (`acceptedLicenses`); none when unset. */
export function acceptedLicenses(profile: TargetProfile): string[] {
  const accepted = profile.acceptedLicenses ?? [];
  if (!Array.isArray(accepted) || accepted.some((l) => typeof l !== "string")) {
    throw new InputError(`the target profile's acceptedLicenses must be a list of licence IDs`);
  }
  return accepted;
}

/**
 * The licence an output with this grant is declared under in the target, or why it cannot be
 * declared: the target's licence when the grant allows relabelling (or there is no grant), else
 * the granted licence when it is commercial and the target lists it in `acceptedLicenses`.
 */
export function licenseDecision(
  profile: TargetProfile,
  grant: OutputGrant | undefined,
): { license: string } | { refused: string } {
  if (!grant || grant.relabel) return { license: profile.license };
  const where = `${grant.license} (${grant.plan} plan)`;
  if (!grant.commercial) {
    return {
      refused:
        `the provider's terms grant ${where} without commercial use; ` +
        `${profile.name} cannot take it under ${profile.license} or any other licence`,
    };
  }
  if (acceptedLicenses(profile).includes(grant.license)) return { license: grant.license };
  return {
    refused:
      `the provider's terms grant ${where}` +
      `${grant.attribution ? `, which requires the credit "${grant.attribution}"` : ""}` +
      `, not ownership; ${profile.name} would relabel it as ${profile.license}. ` +
      `List "${grant.license}" in the target profile's acceptedLicenses to accept it on purpose`,
  };
}

/**
 * The grant and declared licence fields of a provenance made of these calls, for staging: when
 * the target cannot take the output, `license` is the granted licence, and hand-off refuses it.
 */
export function licenseFields(
  profile: TargetProfile,
  calls: CallRecord[],
): { license: string; outputGrant?: OutputGrant } {
  const outputGrant = grantOf(calls);
  const decision = licenseDecision(profile, outputGrant);
  return {
    license: "license" in decision ? decision.license : (outputGrant as OutputGrant).license,
    ...(outputGrant && { outputGrant }),
  };
}

/**
 * The provenance as it is handed to the target: the grant re-derived from its calls and the licence
 * it is declared under. Throws a LicenseError when the target cannot declare it.
 */
export function requireLicensable(profile: TargetProfile, provenance: Provenance): Provenance {
  const calls = Array.isArray(provenance.calls) ? provenance.calls : [];
  const outputGrant = grantOf(calls);
  const decision = licenseDecision(profile, outputGrant);
  if ("refused" in decision) throw new LicenseError(`refused hand-off: ${decision.refused}`);
  const { outputGrant: _stale, ...rest } = provenance;
  void _stale;
  return { ...rest, license: decision.license, ...(outputGrant && { outputGrant }) };
}
