/**
 * @vibecontrols/vibe-plugin-tunnel-vibetunnels
 *
 * frp-based tunnel provider for the VibeControls Agent. Registers a
 * concrete TunnelProvider named "tunnel-vibetunnels" in the agent's
 * service registry, which the tunnel manager plugin dispatches to.
 *
 * Migrated to consume `@vibecontrols/plugin-sdk` for the contract,
 * lifecycle, telemetry, logger and provider-registry helpers.
 */
import {
  BoundLogger,
  createLifecycleHooks,
  ProviderRegistry,
  TelemetryEmitter,
} from "@vibecontrols/plugin-sdk";
import type {
  HostServices,
  VibePlugin,
} from "@vibecontrols/plugin-sdk/contract";

import { VibeTunnelsProvider } from "./provider.js";
import { PROVIDER_NAME, type TunnelProvider } from "./types.js";

const PLUGIN_VERSION = "2026.509.2";

/**
 * Local extension of the SDK contract — `providers` slot is an
 * agent-host extension surfaced to the runtime registry. The SDK
 * contract leaves it to the host implementation.
 */
type VibeTunnelsVibePlugin = VibePlugin & {
  providers?: { tunnel?: TunnelProvider };
};

let provider: VibeTunnelsProvider | null = null;

const telemetry = new TelemetryEmitter(PROVIDER_NAME, PLUGIN_VERSION);

const lifecycle = createLifecycleHooks({
  name: PROVIDER_NAME,
  telemetryEventName: "tunnel.provider.ready",
  onInit: async (hostServices: HostServices) => {
    const log = new BoundLogger(hostServices.logger, PROVIDER_NAME);

    provider = new VibeTunnelsProvider(hostServices);
    vibePlugin.providers = { tunnel: provider };

    telemetry.emit("tunnel.provider.ready", { provider: "vibetunnels" });

    // Health-check (don't fail startup — surface via getCapabilities).
    const health = await provider.healthCheck();
    if (!health.ok) {
      log.warn(`frpc not available: ${health.message ?? "unknown"}`);
    } else {
      log.info(`frpc ready: ${JSON.stringify(health.details ?? {})}`);
    }

    await provider.resumeOrphanedTunnels();

    // Auto-register with the host's service registry. The agent's
    // runtime registry exposes `registerProvider(type, provider, name)`,
    // a richer surface than the SDK's neutral `registerService(type,
    // name, instance)`. The SDK's ProviderRegistry façade calls
    // `registerService` underneath which the agent forwards through.
    const providers = new ProviderRegistry(hostServices);
    providers.registerProvider("tunnel", PROVIDER_NAME, provider);
  },
  onShutdown: async () => {
    if (!provider) return;
    await provider.stopAll();
    provider = null;
  },
});

export const vibePlugin: VibeTunnelsVibePlugin = {
  capabilities: {
    storage: "rw",
    subprocess: true,
    telemetry: true,
  },
  name: PROVIDER_NAME,
  version: PLUGIN_VERSION,
  description: "VibeTunnels frp-based tunnel provider",
  tags: ["backend", "provider"],
  providers: {},

  onServerStart: lifecycle.onServerStart,
  onServerStop: lifecycle.onServerStop,
};

export default vibePlugin;
export { VibeTunnelsProvider } from "./provider.js";
export * from "./types.js";
