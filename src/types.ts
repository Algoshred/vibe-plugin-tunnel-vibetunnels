/**
 * Tunnel-domain types for the vibetunnels (frp) provider plugin. The
 * plugin contract types (VibePlugin / HostServices / PluginCapabilities)
 * come from `@vibecontrols/plugin-sdk` — do NOT redeclare them here.
 *
 * The shapes below mirror the canonical TunnelProvider contract from
 * `@vibecontrols/agent` so the plugin remains free of a hard dependency
 * on the agent package while still type-checking the dispatch surface.
 */

export type TunnelStatus =
  | "starting"
  | "active"
  | "stopping"
  | "stopped"
  | "error";

export type TunnelProtocol = "http" | "https" | "tcp" | "udp";

export interface TunnelProviderCapabilities {
  provider: string;
  supportsHttp: boolean;
  supportsHttps: boolean;
  supportsTcp: boolean;
  supportsUdp: boolean;
  supportsCustomDomains: boolean;
  supportsManagedSubdomains: boolean;
  supportsSessionTokens: boolean;
  supportsLiveLogs: boolean;
  supportsUsageMetrics: boolean;
  supportsRotateCredentials: boolean;
  platforms: string[];
}

export interface IssueSessionRequest {
  protocol: TunnelProtocol;
  localPort: number;
  localHost?: string;
  subdomain?: string;
  customDomain?: string;
  ttlSeconds?: number;
  metadata?: Record<string, unknown>;
  controlPlanePayload?: Record<string, unknown>;
}

export interface TunnelSessionInfo {
  sessionId: string;
  tunnelId: string;
  provider: string;
  managedHostname?: string;
  customDomains?: string[];
  expiresAt?: string;
  credentials: Record<string, unknown>;
}

export interface TunnelMetrics {
  bytesIn: number;
  bytesOut: number;
  connections: number;
  lastActivityAt?: string;
}

export interface TunnelInfo {
  id: string;
  providerName: string;
  status: TunnelStatus;
  protocol: TunnelProtocol;
  localPort: number;
  localHost: string;
  url: string;
  managedHostname?: string;
  customDomains?: string[];
  sessionId?: string;
  shardId?: string;
  pid?: number;
  createdAt: string;
  updatedAt?: string;
  metrics?: TunnelMetrics;
  metadata?: Record<string, unknown>;
}

export interface TunnelProvider {
  readonly name: string;
  getCapabilities(): TunnelProviderCapabilities;
  healthCheck(): Promise<{
    ok: boolean;
    message?: string;
    details?: Record<string, unknown>;
  }>;
  issueSession(req: IssueSessionRequest): Promise<TunnelSessionInfo>;
  start(tunnelId: string): Promise<TunnelInfo>;
  stop(tunnelId: string): Promise<void>;
  delete(tunnelId: string): Promise<void>;
  rotate(tunnelId: string): Promise<TunnelSessionInfo>;
  getStatus(tunnelId: string): Promise<TunnelInfo | null>;
  list(): Promise<TunnelInfo[]>;
  attachCustomDomain(tunnelId: string, domain: string): Promise<void>;
  detachCustomDomain(tunnelId: string, domain: string): Promise<void>;
  listSessions(tunnelId: string): Promise<TunnelSessionInfo[]>;
  getMetrics?(tunnelId: string): Promise<TunnelMetrics | null>;
  getActiveTunnelUrl?(): Promise<string | null>;
}

/**
 * Agent's runtime storage surface — string-typed get/set + void delete +
 * list. Structurally compatible with the SDK's neutral StorageProvider
 * but with the concrete shapes the agent emits at runtime.
 */
export interface AgentStorageProvider {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  list(namespace: string): Promise<string[]>;
}

export const PROVIDER_NAME = "tunnel-vibetunnels";
export const STORAGE_NS = "tunnel-vibetunnels";
export const KEY_TUNNELS = "tunnels";
export const KEY_SESSIONS_PREFIX = "sessions:";
export const KILL_GRACE_MS = 3_000;
export const START_TIMEOUT_MS = 25_000;
