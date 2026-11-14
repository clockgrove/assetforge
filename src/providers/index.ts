import { VercelGateway } from "../gateway/vercel.ts";
import { ScriptedProvider } from "../gateway/scripted.ts";
import type { Script } from "../gateway/scripted.ts";
import type { GenerationProvider } from "../gateway/provider.ts";
import { RoutedProvider } from "../gateway/routed.ts";
import { TripoProvider } from "../gateway/tripo.ts";
import { ProviderError } from "../errors.ts";
import type { ToolContext } from "../mcp.ts";
import { CHARACTER_3D_KIND } from "../model3d/profile.ts";
import { SpendLedger, UNPAID_PROVIDER } from "../spend.ts";
import type { AssetSpec } from "../types.ts";
import { loadScript } from "./script.ts";

export { loadScript } from "./script.ts";

/** A provider and the name its calls are recorded under. */
export interface NamedProvider {
  provider: GenerationProvider;
  name: string;
}

/** The Vercel AI Gateway from AI_GATEWAY_API_KEY; without a key, a ProviderError (exit 4). */
export function gatewayProvider(): GenerationProvider {
  try {
    return VercelGateway.fromEnv();
  } catch (error) {
    throw new ProviderError((error as Error).message, { cause: error });
  }
}

/**
 * The scripted provider of --provider-script, under its unpaid name; a script that declares
 * `paid: true` (tests only) runs as `scripted-paid`, whose calls the spend ledger counts.
 */
export function scriptedProvider(script: Script): NamedProvider {
  return {
    provider: new ScriptedProvider(script),
    name: script.paid === true ? `${UNPAID_PROVIDER}-paid` : UNPAID_PROVIDER,
  };
}

/** The scripted provider of --provider-script when given, else undefined. */
export async function scriptedFrom(
  providerScript: string | undefined,
): Promise<NamedProvider | undefined> {
  return providerScript ? scriptedProvider(await loadScript(providerScript)) : undefined;
}

/** The provider of a run: the --provider-script module when given, else the gateway. */
export async function providerFor(providerScript: string | undefined): Promise<NamedProvider> {
  return (
    (await scriptedFrom(providerScript)) ?? {
      provider: gatewayProvider(),
      name: "vercel-ai-gateway",
    }
  );
}

/**
 * The provider name a dry run would use, loading (and so checking) --provider-script when given:
 * undefined, a real paid provider, without one.
 */
export async function dryRunProvider(
  providerScript: string | undefined,
): Promise<string | undefined> {
  return (await scriptedFrom(providerScript))?.name;
}

/**
 * The real provider of a stage run: 3D characters make their 3D calls on Tripo (TRIPO_API_KEY)
 * and their identity calls on the gateway; other kinds use the gateway alone.
 */
export function stageProvider(spec: AssetSpec): {
  provider: GenerationProvider;
  providerName: string;
} {
  if (spec.kind !== CHARACTER_3D_KIND) {
    return { provider: gatewayProvider(), providerName: "vercel-ai-gateway" };
  }
  return {
    provider: new RoutedProvider({
      gateway: () => VercelGateway.fromEnv(),
      models: () => TripoProvider.fromEnv(),
    }),
    providerName: "tripo+vercel-ai-gateway",
  };
}

/**
 * The cross-run spend ledger of this invocation (src/spend.ts): its path and limits from the
 * environment, the work item from --work-item or ASSETGROVE_WORK_ITEM.
 */
export function spendLedger(workItem: string | undefined): SpendLedger {
  return SpendLedger.fromEnv(process.env, workItem !== undefined ? { workItem } : {});
}

/**
 * The context of the planning tools (plan, apply, mcp): the scripted provider, else the gateway
 * when AI_GATEWAY_API_KEY is set, else no provider.
 */
export async function planningContext(
  providerScript: string | undefined,
  workItem: string | undefined,
): Promise<ToolContext> {
  const ledger = spendLedger(workItem);
  const scripted = await scriptedFrom(providerScript);
  if (scripted) return { provider: scripted.provider, providerName: scripted.name, ledger };
  if (process.env["AI_GATEWAY_API_KEY"])
    return { provider: gatewayProvider(), providerName: "vercel-ai-gateway", ledger };
  return { ledger };
}
