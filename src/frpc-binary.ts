/**
 * Resolve the path to an frpc binary.
 *
 * Resolution order:
 *   1. VIBETUNNELS_FRPC_PATH env var (if the file exists and is executable)
 *   2. `frpc` on $PATH
 *
 * Auto-download is documented in the README but intentionally not implemented
 * here — shipping an auto-downloader with checksum pinning is a separate
 * concern that merits its own review. Operators should install frpc via
 * their package manager or supply VIBETUNNELS_FRPC_PATH.
 */
import { existsSync } from "node:fs";

export class FrpcNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrpcNotFoundError";
  }
}

async function which(binary: string): Promise<string | null> {
  // Bun.which works on every supported platform (POSIX + Windows) and
  // already understands PATHEXT (.exe/.cmd) on Windows. Replaces the old
  // POSIX-only `which` subprocess.
  const found = Bun.which(binary);
  if (found && existsSync(found)) return found;
  return null;
}

export async function resolveFrpcBinary(): Promise<string> {
  const envPath = process.env["VIBETUNNELS_FRPC_PATH"];
  if (envPath && existsSync(envPath)) return envPath;

  const which_ = await which("frpc");
  if (which_) return which_;

  throw new FrpcNotFoundError(
    "frpc binary not found. Install frpc or set VIBETUNNELS_FRPC_PATH.",
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
