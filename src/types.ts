/**
 * Locally-redeclared types. Mirrors the canonical TunnelProvider contract
 * from @vibecontrols/agent.
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

export interface StorageProvider {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  list(namespace: string): Promise<string[]>;
  deleteAll(namespace: string): Promise<void>;
}

export interface Logger {
  debug(source: string, msg: string, meta?: Record<string, unknown>): void;
  info(source: string, msg: string, meta?: Record<string, unknown>): void;
  warn(source: string, msg: string, meta?: Record<string, unknown>): void;
  error(source: string, msg: string, meta?: Record<string, unknown>): void;
}

export interface ServiceRegistryLike {
  registerProvider?(type: string, provider: unknown, pluginName: string): void;
}

export interface HostServices {
  telemetry?: {
    emit: (name: string, payload?: Record<string, unknown>) => void;
  };
  storage: StorageProvider;
  logger: Logger;
  serviceRegistry: ServiceRegistryLike;
}

export interface PluginCapabilities {
  storage?: "none" | "read" | "rw";
  secrets?: "none" | "read" | "rw";
  gateway?: boolean;
  broadcast?: boolean;
  subprocess?: boolean;
  audit?: boolean;
  telemetry?: boolean;
}

export interface VibePlugin {
  capabilities?: PluginCapabilities;
  name: string;
  version: string;
  description?: string;
  tags?: Array<
    "backend" | "frontend" | "cli" | "provider" | "adapter" | "integration"
  >;
  providers?: { tunnel?: TunnelProvider };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onServerStart?: (
    app: any,
    hostServices: HostServices,
  ) => void | Promise<void>;
  onServerStop?: (ctx?: {
    reason: "reload" | "shutdown";
  }) => void | Promise<void>;
}

export const PROVIDER_NAME = "tunnel-vibetunnels";
export const STORAGE_NS = "tunnel-vibetunnels";
export const KEY_TUNNELS = "tunnels";
export const KEY_SESSIONS_PREFIX = "sessions:";
export const KILL_GRACE_MS = 3_000;
export const START_TIMEOUT_MS = 25_000;
