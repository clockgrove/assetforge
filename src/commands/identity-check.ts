import { Budget } from "../budget.ts";
import { loadBible } from "../bible.ts";
import { Caller } from "../calls.ts";
import { InputError } from "../errors.ts";
import { checkIdentityRecord, loadIdentity } from "../identity.ts";
import type { IdentityRecordCheck } from "../identity.ts";
import { DEFAULT_CAP_USD } from "../loop.ts";
import { providerFor, spendLedger } from "../providers/index.ts";
import { IDENTITY_CHECK_OPERATION, loadRoutes } from "../routes.ts";
import type { Route } from "../routes.ts";
import { ledgerFor } from "../spend.ts";
import { defineCommand } from "./types.ts";

interface IdentityCheckArgs {
  bible: string;
  subject?: string[];
  routes?: string;
  cap?: number;
  workItem?: string;
  providerScript?: string;
}

export const identityCheckCommand = defineCommand<IdentityCheckArgs>({
  name: "identity-check",
  tool: null,
  summary: "check that identity records agree with their own approved references",
  details: `Asks the identity-check route whether each identity record's written signature features,
proportions and palette agree with the record's approved reference images (the source of truth).
Checks every identity in the bible, or the named subjects. Exits 1 when any record disagrees or
could not be checked: identity enforce mode does not filter with such a record until a person
fixes its text or its references. See docs/generation-knobs.md.`,
  input: {
    type: "object",
    properties: {
      bible: {
        type: "string",
        description: "the BIBLE.md holding the identity records",
        placeholder: "<BIBLE.md>",
      },
      subject: {
        type: "array",
        items: { type: "string" },
        description: "a subject to check; repeat for several (default: every identity)",
        placeholder: "<name>",
      },
      routes: { type: "string", description: "model routes", placeholder: "<routes.json>" },
      cap: { type: "number", description: "the run's cost cap in USD", default: DEFAULT_CAP_USD },
      workItem: {
        type: "string",
        description: "the work item the spend ledger counts against",
        placeholder: "<label>",
      },
      providerScript: {
        type: "string",
        description: "answer every model call from this module instead of a provider",
        placeholder: "<module>",
      },
    },
    required: ["bible"],
    additionalProperties: false,
  },
  effect: { readOnly: true, spends: "always", writes: "none" },
  async run(args, ctx) {
    const doc = await loadBible(args.bible);
    const named = args.subject ?? [];
    const subjects = named.length > 0 ? named : Object.keys(doc.data.identities).sort();
    const loaded = await Promise.all(
      subjects.map(async (subject) => {
        const identity = await loadIdentity(doc, subject);
        if (!identity) throw new InputError(`"${subject}" has no identity lock in ${doc.path}`);
        return identity;
      }),
    );
    if (loaded.length === 0) throw new InputError(`${doc.path} has no identity locks`);
    const routes = await loadRoutes(args.routes);
    const { provider, name } = await providerFor(args.providerScript);
    const budget = new Budget(
      args.cap ?? DEFAULT_CAP_USD,
      ledgerFor(spendLedger(args.workItem), name, {}),
    );
    budget.check(
      loaded.length * (routes[IDENTITY_CHECK_OPERATION] as Route).estimatedCostUsd,
      `${loaded.length} identity record checks`,
    );
    const caller = new Caller({
      provider,
      providerName: name,
      budget,
      routes,
      log: ctx.log,
    });
    const checks: IdentityRecordCheck[] = [];
    for (const identity of loaded) checks.push(await checkIdentityRecord({ caller, ...identity }));
    const ok = checks.every((c) => c.checked && c.consistent);
    const fields = { checks, spentUsd: budget.spentUsd };
    const human = checks.map((c) => c.reason).join("\n");
    return { exitCode: ok ? 0 : 1, fields, human };
  },
});
