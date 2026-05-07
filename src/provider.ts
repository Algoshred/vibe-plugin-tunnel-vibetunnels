/**
 * VibeTunnelsProvider — implements the TunnelProvider interface against
 * a shared `frps` server. Spawns `frpc` subprocesses locally.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

import { buildFrpcConfig, extractFrpsHint } from "./frpc-config.js";
import { resolveFrpcBinary, verifyFrpc } from "./frpc-binary.js";
import {
  KEY_TUNNELS,
  KEY_SESSIONS_PREFIX,
  KILL_GRACE_MS,
  PROVIDER_NAME,
  START_TIMEOUT_MS,
  STORAGE_NS,
  type HostServices,
  type IssueSessionRequest,
  type Logger,
  type StorageProvider,
  type TunnelInfo,
  type TunnelProvider,
  type TunnelProviderCapabilities,
  type TunnelSessionInfo,
} from "./types.js";

const LOG = "tunnel-vibetunnels";

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gracefulKill(pid: number | undefined): Promise<void> {
  if (!pid || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (!isProcessAlive(pid)) return;
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function configDir(): string {
  const dir = join(
    process.env["VIBECONTROLS_DIR"] ?? join(homedir(), ".boff", "vibecontrols"),
    "plugins",
    "tunnel-vibetunnels",
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function waitForFrpcStart(proc: Subprocess): Promise<{
  success: boolean;
  output: string;
}> {
  let output = "";
  let settled = false;
  const decoder = new TextDecoder();

  return new Promise((resolve) => {
    const finish = (success: boolean, suffix = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve({ success, output: `${output}${suffix}` });
    };

    const inspect = () => {
      if (/start proxy success/i.test(output)) {
        finish(true);
        return;
      }
      if (
        /login to server failed|authentication failed|start error|start proxy error/i.test(
          output,
        )
      ) {
        finish(false);
      }
    };

    const readStream = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          output += decoder.decode(value, { stream: true });
          inspect();
        }
      } catch (err) {
        if (!settled) output += `\n${String(err)}`;
      } finally {
        reader.releaseLock();
      }
    };

    void readStream(proc.stdout as ReadableStream<Uint8Array> | null);
    void readStream(proc.stderr as ReadableStream<Uint8Array> | null);
    void proc.exited.then((code) => {
      finish(false, `\nfrpc exited with code ${code}`);
    });

    const timeoutId = setTimeout(() => {
      finish(
        false,
        `\nTimed out after ${START_TIMEOUT_MS}ms waiting for frpc start success`,
      );
    }, START_TIMEOUT_MS);
  });
}

export class VibeTunnelsProvider implements TunnelProvider {
  readonly name = PROVIDER_NAME;

  private readonly processes = new Map<string, Subprocess>();
  private readonly storage: StorageProvider;
  private readonly log: Logger;

  constructor(host: HostServices) {
    this.storage = host.storage;
    this.log = host.logger;
  }

  /**
   * Return the agent's currently active control-plane tunnel URL, if any.
   *
   * vibetunnels (frp-based) handles SESSION tunnels, not the agent's own
   * HTTP tunnel — that's spawned by the agent's pre-config phase
   * (src/core/tunnel-bootstrap.ts in @vibecontrols/agent) using
   * cloudflared. The auto-report subsystem queries whichever tunnel
   * provider is registered first; if that's us, we surface the
   * bootstrap-cloudflared URL so the platform records it correctly.
   *
   * Multi-agent isolation: read AGENT_TUNNEL_URL_<profile> where profile
   * is this process's VIBECONTROLS_PROFILE (same handle that scopes
   * on-disk state). Two agents in the same process tree never see each
   * other's URL because each profile has its own env key. Bootstrap
   * writes the same key.
   *
   * The unsuffixed `AGENT_TUNNEL_URL` is honoured ONLY when an
   * operator pins it explicitly (external-tunnel mode); we never
   * fall back to it from the bootstrap path because that would let
   * stale env from one agent leak into another.
   */
  async getActiveTunnelUrl(): Promise<string | null> {
    // Per-profile key set by tunnel-bootstrap.
    const profile = process.env.VIBECONTROLS_PROFILE ?? "default";
    const profileSuffix = profile.replace(/[^A-Za-z0-9_]/g, "_");
    const suffixed = process.env[`AGENT_TUNNEL_URL_${profileSuffix}`];
    if (suffixed) return suffixed;
    // External-tunnel mode: operator pinned `AGENT_TUNNEL_URL=...`
    // before launching `vibe start`. The unsuffixed key is the
    // operator's intent — agent processes inheriting this from the
    // shell are explicitly opting into "external mode" together.
    const externalUrl = process.env.AGENT_TUNNEL_URL;
    if (externalUrl) return externalUrl;
    // No bootstrap URL and no operator pin; vibetunnels doesn't manage
    // the agent's primary HTTP tunnel itself, so return null and let
    // the caller fall back to other discovery (e.g. agent record on
    // the backend).
    return null;
  }

  // ── Capabilities + health ───────────────────────────────────────────

  getCapabilities(): TunnelProviderCapabilities {
    return {
      provider: PROVIDER_NAME,
      supportsHttp: true,
      supportsHttps: true,
      supportsTcp: true,
      supportsUdp: false,
      supportsCustomDomains: true,
      supportsManagedSubdomains: true,
      supportsSessionTokens: true,
      supportsLiveLogs: true,
      supportsUsageMetrics: false,
      supportsRotateCredentials: true,
      platforms: ["darwin", "linux", "win32"],
    };
  }

  async healthCheck(): Promise<{
    ok: boolean;
    message?: string;
    details?: Record<string, unknown>;
  }> {
    try {
      const frpcPath = await resolveFrpcBinary();
      const result = await verifyFrpc(frpcPath);
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
      return { ok: true, details: { frpcPath, version: result.version } };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  }

  // ── Storage helpers ─────────────────────────────────────────────────

  private async loadTunnels(): Promise<TunnelInfo[]> {
    const raw = await this.storage.get(STORAGE_NS, KEY_TUNNELS);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as TunnelInfo[];
    } catch {
      this.log.warn(LOG, "Corrupt tunnel list — resetting");
      return [];
    }
  }

  private async saveTunnels(tunnels: TunnelInfo[]): Promise<void> {
    await this.storage.set(STORAGE_NS, KEY_TUNNELS, JSON.stringify(tunnels));
  }

  private async upsertTunnel(info: TunnelInfo): Promise<void> {
    const tunnels = await this.loadTunnels();
    const idx = tunnels.findIndex((t) => t.id === info.id);
    if (idx >= 0) tunnels[idx] = info;
    else tunnels.push(info);
    await this.saveTunnels(tunnels);
  }

  private async loadSessions(tunnelId: string): Promise<TunnelSessionInfo[]> {
    const raw = await this.storage.get(
      STORAGE_NS,
      KEY_SESSIONS_PREFIX + tunnelId,
    );
    if (!raw) return [];
    try {
      return JSON.parse(raw) as TunnelSessionInfo[];
    } catch {
      return [];
    }
  }

  private async saveSessions(
    tunnelId: string,
    sessions: TunnelSessionInfo[],
  ): Promise<void> {
    await this.storage.set(
      STORAGE_NS,
      KEY_SESSIONS_PREFIX + tunnelId,
      JSON.stringify(sessions),
    );
  }

  // ── Interface impl ──────────────────────────────────────────────────

  async issueSession(req: IssueSessionRequest): Promise<TunnelSessionInfo> {
    const hint = extractFrpsHint(req);
    // Key agent-side storage by the backend tunnel id when the control
    // plane provides one. Without this the agent mints a random UUID and
    // the backend's subsequent stop/start calls (which use the backend
    // id) silently miss, leaving frpc processes orphaned.
    const backendTunnelId =
      typeof req.metadata?.["backendTunnelId"] === "string"
        ? (req.metadata["backendTunnelId"] as string)
        : undefined;
    const tunnelId = backendTunnelId ?? crypto.randomUUID();
    const sessionId = hint.sessionId ?? crypto.randomUUID();
    const localHost = req.localHost ?? "127.0.0.1";
    const configPath = join(configDir(), `${tunnelId}.toml`);

    // Combine the agent-side `customDomain` (passed via the issueSession
    // request body) with any control-plane custom domains the backend
    // attached. Deduplicate so a single user-owned hostname doesn't get
    // emitted twice.
    const customDomains: string[] = [];
    if (req.customDomain) customDomains.push(req.customDomain);
    for (const d of hint.customDomains ?? []) {
      if (!customDomains.includes(d)) customDomains.push(d);
    }

    const toml = buildFrpcConfig({
      serverAddr: hint.serverAddr,
      serverPort: hint.serverPort,
      token: hint.token,
      proxyName: hint.proxyName,
      protocol: req.protocol,
      localHost,
      localPort: req.localPort,
      managedHostname: hint.managedHostname,
      // When the backend pre-computed a `subdomain` prefix (because the
      // managed hostname is under the shard's frps subDomainHost), the
      // generated TOML emits `subdomain = X` instead of including the
      // managed hostname under `customDomains` — frps rejects the latter.
      subdomain: hint.subdomain,
      customDomains,
    });

    writeFileSync(configPath, toml, "utf-8");

    const info: TunnelInfo = {
      id: tunnelId,
      providerName: PROVIDER_NAME,
      status: "starting",
      protocol: req.protocol,
      localPort: req.localPort,
      localHost,
      url: hint.managedHostname
        ? `${req.protocol === "tcp" ? "tcp" : req.protocol}://${hint.managedHostname}`
        : "",
      managedHostname: hint.managedHostname,
      customDomains,
      sessionId,
      shardId: hint.shardId,
      createdAt: new Date().toISOString(),
      metadata: {
        configPath,
        proxyName: hint.proxyName,
      },
    };
    await this.upsertTunnel(info);

    const session: TunnelSessionInfo = {
      sessionId,
      tunnelId,
      provider: PROVIDER_NAME,
      managedHostname: hint.managedHostname,
      customDomains,
      expiresAt: req.ttlSeconds
        ? new Date(Date.now() + req.ttlSeconds * 1000).toISOString()
        : undefined,
      credentials: {
        configPath,
        proxyName: hint.proxyName,
      },
    };
    const sessions = await this.loadSessions(tunnelId);
    sessions.push(session);
    await this.saveSessions(tunnelId, sessions);

    return session;
  }

  async start(tunnelId: string): Promise<TunnelInfo> {
    const tunnels = await this.loadTunnels();
    const info = tunnels.find((t) => t.id === tunnelId);
    if (!info) {
      throw new Error(`Tunnel ${tunnelId} not found`);
    }
    if (this.processes.has(tunnelId)) {
      return info;
    }

    const configPath = (info.metadata?.configPath ?? "") as string;
    if (!configPath) {
      throw new Error(
        `Tunnel ${tunnelId} has no configPath — re-issue session`,
      );
    }
    const frpcPath = await resolveFrpcBinary();

    this.log.info(LOG, `Spawning frpc for tunnel ${tunnelId}`);
    const proc = Bun.spawn([frpcPath, "-c", configPath], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.processes.set(tunnelId, proc);

    const { success, output } = await waitForFrpcStart(proc);

    if (!success) {
      this.processes.delete(tunnelId);
      await gracefulKill(proc.pid);
      const errored: TunnelInfo = {
        ...info,
        status: "error",
        updatedAt: new Date().toISOString(),
        metadata: { ...info.metadata, startError: output.slice(-500) },
      };
      await this.upsertTunnel(errored);
      throw new Error(`frpc failed to report success: ${output.slice(-200)}`);
    }

    void proc.exited.then(async (code) => {
      if (!this.processes.has(tunnelId)) return;
      this.processes.delete(tunnelId);
      this.log.warn(
        LOG,
        `frpc for ${tunnelId} exited unexpectedly (code=${code})`,
      );
      const current = await this.loadTunnels();
      const idx = current.findIndex((t) => t.id === tunnelId);
      if (idx >= 0) {
        current[idx] = {
          ...current[idx]!,
          status: "error",
          updatedAt: new Date().toISOString(),
        };
        await this.saveTunnels(current);
      }
    });

    const active: TunnelInfo = {
      ...info,
      status: "active",
      pid: proc.pid,
      updatedAt: new Date().toISOString(),
      url: info.managedHostname
        ? `${info.protocol === "tcp" ? "tcp" : info.protocol}://${info.managedHostname}`
        : info.url,
    };
    await this.upsertTunnel(active);
    return active;
  }

  async stop(tunnelId: string): Promise<void> {
    const proc = this.processes.get(tunnelId);
    if (proc) {
      await gracefulKill(proc.pid);
      this.processes.delete(tunnelId);
    }
    const tunnels = await this.loadTunnels();
    const idx = tunnels.findIndex((t) => t.id === tunnelId);
    if (idx >= 0) {
      tunnels[idx] = {
        ...tunnels[idx]!,
        status: "stopped",
        pid: undefined,
        updatedAt: new Date().toISOString(),
      };
      await this.saveTunnels(tunnels);
    }
  }

  async delete(tunnelId: string): Promise<void> {
    await this.stop(tunnelId);
    const tunnels = await this.loadTunnels();
    await this.saveTunnels(tunnels.filter((t) => t.id !== tunnelId));
    await this.storage.delete(STORAGE_NS, KEY_SESSIONS_PREFIX + tunnelId);
  }

  async rotate(tunnelId: string): Promise<TunnelSessionInfo> {
    const tunnels = await this.loadTunnels();
    const info = tunnels.find((t) => t.id === tunnelId);
    if (!info) throw new Error(`Tunnel ${tunnelId} not found`);

    // Stop first so the new frpc can bind cleanly.
    await this.stop(tunnelId);

    // Without a fresh controlPlanePayload from the backend we cannot
    // re-issue here. The caller (backend) is expected to mint a new
    // session and feed it back through issueSession.
    throw new Error(
      "rotate requires a new session from the backend — call issueSession with a refreshed controlPlanePayload instead",
    );
  }

  async getStatus(tunnelId: string): Promise<TunnelInfo | null> {
    const tunnels = await this.loadTunnels();
    return tunnels.find((t) => t.id === tunnelId) ?? null;
  }

  async list(): Promise<TunnelInfo[]> {
    return this.loadTunnels();
  }

  async attachCustomDomain(tunnelId: string, domain: string): Promise<void> {
    const tunnels = await this.loadTunnels();
    const idx = tunnels.findIndex((t) => t.id === tunnelId);
    if (idx < 0) throw new Error(`Tunnel ${tunnelId} not found`);
    const current = tunnels[idx]!;
    const domains = current.customDomains ? [...current.customDomains] : [];
    if (!domains.includes(domain)) domains.push(domain);
    tunnels[idx] = {
      ...current,
      customDomains: domains,
      updatedAt: new Date().toISOString(),
    };
    await this.saveTunnels(tunnels);
    // frp OSS cannot reload config — caller must rotate() to apply.
    this.log.warn(
      LOG,
      `Attached ${domain} to ${tunnelId}; rotate tunnel to apply.`,
    );
  }

  async detachCustomDomain(tunnelId: string, domain: string): Promise<void> {
    const tunnels = await this.loadTunnels();
    const idx = tunnels.findIndex((t) => t.id === tunnelId);
    if (idx < 0) throw new Error(`Tunnel ${tunnelId} not found`);
    const current = tunnels[idx]!;
    const domains = (current.customDomains ?? []).filter((d) => d !== domain);
    tunnels[idx] = {
      ...current,
      customDomains: domains,
      updatedAt: new Date().toISOString(),
    };
    await this.saveTunnels(tunnels);
  }

  async listSessions(tunnelId: string): Promise<TunnelSessionInfo[]> {
    return this.loadSessions(tunnelId);
  }

  // ── Housekeeping ────────────────────────────────────────────────────

  async resumeOrphanedTunnels(): Promise<void> {
    const tunnels = await this.loadTunnels();
    let touched = 0;
    for (const t of tunnels) {
      if (t.status === "active" && !isProcessAlive(t.pid)) {
        t.status = "stopped";
        t.pid = undefined;
        t.updatedAt = new Date().toISOString();
        touched += 1;
      }
    }
    if (touched > 0) {
      await this.saveTunnels(tunnels);
      this.log.info(LOG, `Marked ${touched} orphaned tunnel(s) as stopped`);
    }
  }

  async stopAll(): Promise<void> {
    for (const [id, proc] of this.processes) {
      await gracefulKill(proc.pid);
      this.log.info(LOG, `Stopped tunnel ${id} on shutdown`);
    }
    this.processes.clear();
  }

  detachAll(): void {
    // Hot-reload: leave subprocesses running, just clear in-memory refs.
    this.processes.clear();
  }
}
