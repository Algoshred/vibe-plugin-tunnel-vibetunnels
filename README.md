# @vibecontrols/vibe-plugin-tunnel-vibetunnels

VibeTunnels frp-based tunnel provider for the VibeControls Agent. Spawns
`frpc` to expose local ports via a shared `frps` server running in the
VibeTunnels EKS clusters, producing public URLs at
`*.vibetunnels.com` (prod) / `*.alpha.vibetunnels.com` (alpha).

Registers itself as a `tunnel` provider named `tunnel-vibetunnels`
inside the agent's service registry. Works together with
`@vibecontrols/vibe-plugin-tunnel` (the manager/facade plugin that owns
the `/api/tunnels/*` REST surface).

## Install

```
bun install -g @vibecontrols/vibe-plugin-tunnel-vibetunnels
```

Installed automatically by `vibe start` when VibeTunnels is the default
tunnel provider.

## Requirements

- `frpc` binary in `$PATH`, OR set `VIBETUNNELS_FRPC_PATH` to an
  absolute path, OR let the plugin download a pinned build on first use
  (cached under `~/.boff/vibecontrols/cache/frpc/`).

## How it works

1. The backend issues a tunnel session via GraphQL
   `issueTunnelSession`, returning a `controlPlanePayload` containing
   the frps server address, auth token, proxy name, and managed
   hostname.
2. The CLI POSTs that payload to the local agent's
   `/api/tunnels/issue-session`, which routes through the tunnel
   manager plugin to this provider.
3. The provider writes an `frpc.toml` config into
   `~/.boff/vibecontrols/agents/{profile}/plugins/tunnel-vibetunnels/{tunnelId}.toml`
   and persists a TunnelInfo record in encrypted agent storage.
4. `start(tunnelId)` spawns `frpc -c <configPath>` and scrapes the
   subprocess output for `start proxy success` to transition the
   tunnel to `active`.
5. `stop(tunnelId)` gracefully terminates the frpc subprocess.
6. `rotate(tunnelId)` issues a new session and re-spawns frpc — this
   causes a ~1s interruption because frp OSS does not support dynamic
   config reload.

## Security

- frpc auth tokens are never logged.
- All storage goes through the agent's encrypted Skalex adapter.
- The plugin verifies the frpc binary checksum against a pinned
  manifest before execution when auto-downloading.
