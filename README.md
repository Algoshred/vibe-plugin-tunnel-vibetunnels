# @vibecontrols/vibe-plugin-tunnel-vibetunnels

<!-- VIBECONTROLS_OSS_HEADER_START -->

> **License**: MIT — see [LICENSE](./LICENSE).
> **Note**: This plugin is open source. The `@vibecontrols/agent` runtime that loads it is **not** open source — it is a proprietary product of Burdenoff Consultancy Services Pvt. Ltd. See [vibecontrols.com](https://vibecontrols.com) for the agent.

<!-- VIBECONTROLS_OSS_HEADER_END -->

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

<!-- VIBECONTROLS_OSS_FOOTER_START -->

---

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 Burdenoff Consultancy Services Private Limited, Algoshred Technologies Private Limited, and all its sister companies.

Maintainer: **Vignesh T.V** — <https://github.com/tvvignesh>

## Credits

This plugin builds on the following upstream open-source projects. All trademarks and copyrights remain with their respective owners.

- **frp** — <https://github.com/fatedier/frp>

## About VibeControls

**VibeControls** is the agentic engineering mission control for AI-native teams. Vibe-plugins extend the VibeControls agent with new providers, tools, sessions, tunnels, storage backends, and security stages.

- Website: <https://vibecontrols.com>
- Documentation: <https://docs.vibecontrols.com>
- Plugin SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- All plugins: <https://github.com/algoshred?q=vibe-plugin-&type=all>

## Important: agent is not open source

The `@vibecontrols/agent` runtime that loads and orchestrates these plugins is **closed source** and proprietary to Burdenoff Consultancy Services Pvt. Ltd. Only the plugin contract and the plugins themselves are released under MIT. If you want a fully self-hostable agent, please open an issue or contact the maintainer.

<!-- VIBECONTROLS_OSS_FOOTER_END -->
