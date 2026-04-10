/**
 * @vibecontrols/vibe-plugin-tunnel-vibetunnels
 *
 * frp-based tunnel provider for the VibeControls Agent. Registers a
 * concrete TunnelProvider named "tunnel-vibetunnels" in the agent's
 * service registry, which the tunnel manager plugin dispatches to.
 */
import { VibeTunnelsProvider } from "./provider.js";
import { PROVIDER_NAME, type HostServices, type VibePlugin } from "./types.js";

let provider: VibeTunnelsProvider | null = null;

export const vibePlugin: VibePlugin = {
  name: PROVIDER_NAME,
  version: "0.1.0",
  description: "VibeTunnels frp-based tunnel provider",
  tags: ["backend", "provider"],
  providers: {},

  async onServerStart(_app: unknown, hostServices: HostServices) {
    provider = new VibeTunnelsProvider(hostServices);
    vibePlugin.providers!.tunnel = provider;

    // Check if frpc is available but don't fail startup — health check
    // will surface it when called.
    const health = await provider.healthCheck();
    if (!health.ok) {
      hostServices.logger.warn(
        "tunnel-vibetunnels",
        `frpc not available: ${health.message ?? "unknown"}`,
      );
    } else {
      hostServices.logger.info(
        "tunnel-vibetunnels",
        `frpc ready: ${JSON.stringify(health.details ?? {})}`,
      );
    }

    await provider.resumeOrphanedTunnels();

    // Auto-register with the service registry (the agent does this via
    // plugin.providers.tunnel, but we also accept registry DI).
    hostServices.serviceRegistry.registerProvider?.(
      "tunnel",
      provider,
      PROVIDER_NAME,
    );
  },

  async onServerStop(ctx) {
    if (!provider) return;
    if (ctx?.reason === "reload") {
      provider.detachAll();
    } else {
      await provider.stopAll();
    }
    provider = null;
  },
};

export default vibePlugin;
export { VibeTunnelsProvider } from "./provider.js";
export * from "./types.js";
