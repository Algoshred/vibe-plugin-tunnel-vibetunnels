/**
 * Resolve the path to an frpc binary.
 *
 * Resolution order:
 *   1. VIBETUNNELS_FRPC_PATH env var (if the file exists)
 *   2. The provider-managed binary cache (absolute path, immune to the PATH
 *      snapshot `Bun.which` takes at process start — the reason a freshly
 *      installed frpc was invisible to the running daemon on Windows) then the
 *      current PATH, via the SDK `resolveBinary` helper.
 *
 * Auto-download is wired through the plugin's `/prereqs/install` route which
 * calls the SDK `installBinary` helper. This module never downloads — it only
 * resolves what is already on disk so it is safe to call on every spawn.
 */
import { existsSync } from "node:fs";

import { resolveBinary } from "@vibecontrols/plugin-sdk/install";

export class FrpcNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrpcNotFoundError";
  }
}

export async function resolveFrpcBinary(): Promise<string> {
  const envPath = process.env["VIBETUNNELS_FRPC_PATH"];
  if (envPath && existsSync(envPath)) return envPath;

  const resolved = resolveBinary("frpc");
  if (resolved) return resolved;

  throw new FrpcNotFoundError(
    "frpc binary not found. Run the plugin's /prereqs/install to auto-download it, install frpc manually, or set VIBETUNNELS_FRPC_PATH.",
  );
}

/**
 * Verify the frpc binary is invocable. Returns version text on success.
 */
export async function verifyFrpc(
  frpcPath: string,
): Promise<{ ok: true; version: string } | { ok: false; message: string }> {
  try {
    const proc = Bun.spawn([frpcPath, "-v"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      return { ok: false, message: `frpc exited with code ${code}` };
    }
    return { ok: true, version: text.trim() };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}
