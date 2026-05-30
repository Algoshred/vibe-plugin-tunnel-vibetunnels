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
import { Elysia } from "elysia";

import {
  BoundLogger,
  createLifecycleHooks,
  ProviderRegistry,
  TelemetryEmitter,
} from "@vibecontrols/plugin-sdk";
import type {
  HostServices,
  ProfileContext,
  VibePlugin,
  VibePluginFactory,
} from "@vibecontrols/plugin-sdk/contract";
import {
  installBinary,
  resolveBinary,
  type BinaryDownload,
  type ToolPlatform,
} from "@vibecontrols/plugin-sdk/install";

import { VibeTunnelsProvider } from "./provider.js";
import { PROVIDER_NAME, type TunnelProvider } from "./types.js";

const PLUGIN_VERSION = "2026.509.3";

/**
 * frp (fatedier/frp) release assets per platform. The provider downloads the
 * correct archive to the agent's binary cache (~/.boff/vibecontrols/tools) via
 * the SDK installer and extracts `frpc` from the versioned subdir within — so
 * frpc is owned + installed by THIS plugin and the thin agent never installs
 * it. frp's release assets do NOT publish a "latest" alias, so the version is
 * pinned. Once cached the binary is reused.
 */
const FRP_VER = "0.69.0";
const FRPC_DOWNLOADS: Partial<Record<ToolPlatform, BinaryDownload>> = {
  "linux-x64": {
    url: `https://github.com/fatedier/frp/releases/download/v${FRP_VER}/frp_${FRP_VER}_linux_amd64.tar.gz`,
    archive: "tar.gz",
    binaryWithinArchive: `frp_${FRP_VER}_linux_amd64/frpc`,
  },
  "linux-arm64": {
    url: `https://github.com/fatedier/frp/releases/download/v${FRP_VER}/frp_${FRP_VER}_linux_arm64.tar.gz`,
    archive: "tar.gz",
    binaryWithinArchive: `frp_${FRP_VER}_linux_arm64/frpc`,
  },
  "darwin-x64": {
    url: `https://github.com/fatedier/frp/releases/download/v${FRP_VER}/frp_${FRP_VER}_darwin_amd64.tar.gz`,
    archive: "tar.gz",
    binaryWithinArchive: `frp_${FRP_VER}_darwin_amd64/frpc`,
  },
  "darwin-arm64": {
    url: `https://github.com/fatedier/frp/releases/download/v${FRP_VER}/frp_${FRP_VER}_darwin_arm64.tar.gz`,
    archive: "tar.gz",
    binaryWithinArchive: `frp_${FRP_VER}_darwin_arm64/frpc`,
  },
  "win32-x64": {
    url: `https://github.com/fatedier/frp/releases/download/v${FRP_VER}/frp_${FRP_VER}_windows_amd64.zip`,
    archive: "zip",
    binaryWithinArchive: `frp_${FRP_VER}_windows_amd64/frpc.exe`,
  },
};

/**
 * /prereqs routes — let the agent's first-run prerequisite flow report on and
 * auto-download frpc. `/status` reports presence via `resolveBinary` (cache or
 * PATH, absolute); `/install` downloads frpc into the agent binary cache via
 * `installBinary` when absent, with a manual pendingSudo fallback on failure.
 */
function createPrereqsRoutes() {
  return new Elysia({ prefix: "/prereqs" })
    .get("/status", () => {
      const frpc = resolveBinary("frpc");
      return {
        satisfied: !!frpc,
        missing: frpc
          ? []
          : [
              {
                name: "frpc",
                kind: "binary" as const,
                requiresSudo: false,
                detected: undefined,
              },
            ],
      };
    })
    .post("/install", async () => {
      // Already resolvable (cache or PATH)? Nothing to do.
      if (resolveBinary("frpc")) {
        return { ok: true, installed: [], pendingSudo: [], errors: [] };
      }
      // Auto-download frpc into the agent binary cache. No sudo: the cache
      // lives under the user's home dir.
      try {
        await installBinary({
          name: "frpc",
          downloads: FRPC_DOWNLOADS,
          versionMatcher: "frpc version|frp version",
        });
        return {
          ok: true,
          installed: ["frpc"],
          pendingSudo: [],
          errors: [],
        };
      } catch (err) {
        // Auto-download failed (offline, unsupported arch) — fall back to a
        // manual instruction so the operator can still recover.
        const message = err instanceof Error ? err.message : String(err);
        const manual =
          process.platform === "darwin"
            ? "brew install frp"
            : process.platform === "win32"
              ? "scoop install frpc    # or download from https://github.com/fatedier/frp/releases"
              : "download frp from https://github.com/fatedier/frp/releases and place frpc on your PATH (or set VIBETUNNELS_FRPC_PATH)";
        return {
          ok: false,
          installed: [],
          pendingSudo: [
            {
              name: "frpc",
              command: manual,
              reason: `frpc auto-download failed: ${message}`,
            },
          ],
          errors: [message],
        };
      }
    })
    .post("/uninstall", () => ({ ok: true }));
}

/**
 * Local extension of the SDK contract — `providers` slot is an
 * agent-host extension surfaced to the runtime registry. The SDK
 * contract leaves it to the host implementation.
 */
type VibeTunnelsVibePlugin = VibePlugin & {
  prerequisites?: Array<{
    name: string;
    kind: "binary" | "npm" | "pip" | "cargo" | "manual";
    requiresSudo: boolean;
    description?: string;
  }>;
  providers?: { tunnel?: TunnelProvider };
};

/**
 * Module-level provider singleton — frpc subprocesses are global OS
 * resources and we must not spawn duplicate tunnels per profile. The
 * factory binds the provider once and reuses it across createPlugin
 * calls.
 */
let provider: VibeTunnelsProvider | null = null;

/**
 * Plugin contract V2 factory. Builds a fresh VibePlugin (with its own
 * lifecycle/telemetry instances and providers bag) per call. The
 * `provider` module-level binding is reused across calls because frpc
 * subprocesses are global OS resources — having two profile-instances
 * spawn duplicate tunnels would be unsafe.
 */
export const createPlugin: VibePluginFactory = (
  _ctx: ProfileContext,
): VibePlugin => {
  const telemetry = new TelemetryEmitter(PROVIDER_NAME, PLUGIN_VERSION);

  const plugin: VibeTunnelsVibePlugin = {
    capabilities: {
      storage: "rw",
      subprocess: true,
      telemetry: true,
    },
    name: PROVIDER_NAME,
    version: PLUGIN_VERSION,
    description: "VibeTunnels frp-based tunnel provider",
    tags: ["backend", "provider"],
    // The agent adds this to its tunnel-URL allow-list at registration, so the
    // thin agent never hardcodes a vibetunnels domain in its url-security layer.
    tunnelDomainSuffixes: [".vibetunnels.com"],

    prerequisites: [
      {
        name: "frpc",
        kind: "binary",
        requiresSudo: false,
        description:
          "frp client (auto-downloaded to the agent binary cache); spawned to open tunnels",
      },
    ],

    providers: {},

    createRoutes: () => createPrereqsRoutes(),

    onServerStart: undefined,
    onServerStop: undefined,
  };

  const lifecycle = createLifecycleHooks({
    name: PROVIDER_NAME,
    telemetryEventName: "tunnel.provider.ready",
    onInit: async (hostServices: HostServices) => {
      const log = new BoundLogger(hostServices.logger, PROVIDER_NAME);

      provider = new VibeTunnelsProvider(hostServices);
      plugin.providers = { tunnel: provider };

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
    // `vibe nuke` runs this while the daemon is still up, so the provider
    // singleton + its in-memory process map are reachable. Force-reap every
    // frpc subprocess this provider spawned and wipe its storage namespace.
    // Unlike onShutdown, nuke ALWAYS does the FULL teardown (it never just
    // detaches/preserves) — `nukeAll` kills processes AND clears persisted
    // tunnel/session state. The agent never names frpc; that knowledge
    // lives here.
    onNuke: async (_hostServices, ctx) => {
      if (!provider) return { notes: ["tunnel provider not initialised"] };
      if (ctx.dryRun) {
        return { reaped: ["frpc tunnels + tunnel-vibetunnels storage"] };
      }
      await provider.nukeAll();
      provider = null;
      return { reaped: ["frpc tunnels + tunnel-vibetunnels storage"] };
    },
  });

  plugin.onServerStart = lifecycle.onServerStart;
  plugin.onServerStop = lifecycle.onServerStop;
  plugin.onNuke = lifecycle.onNuke;

  return plugin;
};

export { VibeTunnelsProvider } from "./provider.js";
export * from "./types.js";
