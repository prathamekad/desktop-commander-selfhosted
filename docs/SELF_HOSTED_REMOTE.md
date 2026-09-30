# Personal Self-Hosted Remote MCP
# Personal Self-Hosted Remote MCP

This fork adds a personal-only Remote MCP path that does not depend on the hosted
Desktop Commander relay.

The goal is simple: keep Desktop Commander's mature local filesystem/process tools,
but remove SaaS-side call quotas, billing counters, and multi-tenant control-plane
requirements from the execution path.

## What "unlimited" means

There is no call-credit, monthly allowance, billing meter, or artificial rate limit
in the self-hosted gateway.

Real limits still exist outside the gateway: the AI client/model may have its own
message or tool limits, and the machine is bounded by CPU, RAM, disk, network, and OS
resources.

## Architecture

```text
MCP client
    |
    | Streamable HTTP
    v
Self-hosted gateway
    |
    | authenticated outbound long-poll
    v
Personal device agent
    |
    | stdio MCP
    v
Local Desktop Commander
```

The device initiates the connection. No inbound port is required on the controlled
PC when the gateway is elsewhere.
## Security defaults

- The gateway binds to `127.0.0.1` by default.
- Device endpoints always require `SELFHOST_DEVICE_TOKEN`.
- MCP requests accept the private owner bearer token or a valid OAuth access token.
- OAuth uses PKCE S256, exact redirect URI allowlisting, short-lived access tokens, refresh tokens, and a pre-registered personal client.
- No-auth mode is refused unless the gateway is bound to loopback.
- Self-hosted device mode disables upstream Desktop Commander telemetry.
- Audit logs contain routing metadata only, not tool arguments or tool results.
- A persistent attempted-call journal blocks duplicate execution after delivery retries.
- Existing Desktop Commander allowed-directory and blocked-command controls remain active.
- The self-hosted gateway independently enforces approved absolute workspace roots for filesystem tools.
- Remote config mutation, upstream feedback/prompts, global process/session listing, and historical tool-call listing are not exposed.
- Process-control operations can target only PIDs created through the current remote gateway lifetime.
- Remote URL fetching through the Home device and `node:local` are disabled.
- Remote process commands start from the first approved workspace root and reject obvious path/system-management escapes.
- Arbitrary shell execution is still a powerful capability, not a hard OS sandbox. For a hard process/filesystem boundary, run the device agent under a dedicated OS identity, container, or VM.

The private core listener must remain on loopback. Public access goes through the
separate public facade and a trusted HTTPS tunnel.

## Build and initialize personal credentials

```powershell
npm ci
npm run build
npm run selfhost:init
```

`selfhost:init` generates two strong random credentials without printing them:

- `gateway-secrets.json`: owner + device credentials; keep this on the gateway machine.
- `device-secret.json`: device credential only; this is the only secret file to copy to another personal device.

Both live under `~/.desktop-commander-selfhosted`. Environment variables can still override the files for testing or service deployment.

## Local single-machine test

After `selfhost:init`, terminal 1 can simply run:

```powershell
npm run selfhost:gateway
```

For a deliberately unauthenticated loopback-only MCP test, set `SELFHOST_ALLOW_NOAUTH=true`.
The gateway refuses no-auth mode when bound beyond loopback.
In terminal 2:

```powershell
npm run selfhost:device
```

For a device on another machine, copy only `device-secret.json` into that user's
`~/.desktop-commander-selfhosted` directory and set `SELFHOST_GATEWAY_URL` to the
private gateway URL.

The gateway MCP endpoint is:

```text
http://127.0.0.1:8787/mcp
```

## Authenticated MCP mode

For a client that can send a bearer token:

```powershell
$env:SELFHOST_DEVICE_TOKEN="<device-secret>"
$env:SELFHOST_OWNER_TOKEN="<owner-secret>"
npm run selfhost:gateway
```

Do not reuse the owner token as the device token.

## Public HTTPS + OAuth

The gateway remains bound to loopback. A trusted HTTPS reverse tunnel can publish it
without opening a raw inbound port. For the current personal deployment, Tailscale
Funnel proxies only the public facade:

```text
internet
  -> https://<device>.<tailnet>.ts.net
  -> 127.0.0.1:8788  public OAuth/MCP facade
  -> 127.0.0.1:8787  private gateway core
```

The public facade returns 404 for device/control APIs and accepts `/mcp` only with
a valid OAuth access token. Device-agent endpoints and the private owner bearer remain
on the loopback-only core.

Configure the canonical public origin and public facade port once Funnel is live:

```powershell
npm run selfhost:configure -- --public-base https://<device>.<tailnet>.ts.net --public-port 8788
```

OAuth discovery endpoints are then exposed at:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
/oauth/authorize
/oauth/token
```

The MCP URL is `https://<device>.<tailnet>.ts.net/mcp`.

For Claude custom connectors, use `npm run selfhost:connector-info` locally to obtain
the MCP URL plus OAuth Client ID and Client Secret. The command intentionally does not
print owner/device tokens.

## Windows unattended startup

On Windows, install the current-user Startup launcher:

```powershell
npm run selfhost:install-windows
```

This starts a hidden supervisor at logon. The supervisor keeps the private gateway,
public facade, and device agent running and restarts a child after a crash. When the configured public
origin is a Tailscale `*.ts.net` URL, it also checks Tailscale health every minute: if the
Windows backend falls out of `Running`, it launches the Tailscale IPN client to recover the
active tailnet session; if the Funnel mapping disappears, it reapplies only the configured
loopback MCP port. Remove the launcher with:

```powershell
npm run selfhost:uninstall-windows
```

The installer also creates Start Menu controls under **Desktop Commander Selfhost**:
Start, Status, Restart, Stop, and Usage Dashboard. The equivalent service-control terminal commands are:

```powershell
npm run selfhost:start
npm run selfhost:status
npm run selfhost:restart
npm run selfhost:stop
```

Normal daily use requires none of these commands: signing into Windows starts the
supervisor automatically.

## Usage analytics

The supervisor also starts a loopback-only usage dashboard on port `8790` by default.

Open it with:

```powershell
npm run selfhost:dashboard:open
```

or use **Desktop Commander Selfhost - Usage Dashboard** from the Windows Start Menu.

The dashboard reads the append-only metadata audit ledger directly and does not copy
tool arguments, command text, file contents, OAuth tokens, or MCP results into the
analytics store.

Private owner-authenticated usage APIs are also available on the core gateway:

```text
GET /api/usage/summary?range=today|month|all
GET /api/usage/tools?range=today|month|all&limit=25
GET /api/usage/activity?range=today|month|all
GET /api/usage/events?limit=50
```

The public OAuth/MCP facade intentionally returns 404 for `/api/usage/*`. The local
dashboard exposes one combined loopback endpoint, `GET /api/dashboard?range=...`,
for its UI and `GET /api/healthz` for status checks.

Terminal outcomes are counted once: successful/failed routed completions, gateway-local
calls, policy rejections, timeouts, and abandoned/unknown calls. Dispatch records are
not counted as completed tool calls.

## Multiple personal devices

Run the device agent on each PC with the same gateway URL and device credential.
Each installation persists a random device ID under:

```text
~/.desktop-commander-selfhosted/device.json
```

When only one matching device is online, normal Desktop Commander tool calls route
there automatically. When several matching devices are online, pass `deviceId`.
Use `selfhost_list_devices` to inspect current device IDs and reachability.
## Environment variables

| Variable | Side | Default | Purpose |
| --- | --- | --- | --- |
| `SELFHOST_HOST` | gateway | `127.0.0.1` | Bind address |
| `SELFHOST_PORT` | private gateway | `8787` | Loopback-only core/device port |
| `SELFHOST_PUBLIC_PORT` | public facade | `8788` | Loopback public-facade port used by the HTTPS tunnel |
| `SELFHOST_DASHBOARD_PORT` | dashboard | `8790` | Reserved loopback dashboard port; runtime `--dashboard-port` is preferred |
| `SELFHOST_ALLOWED_ROOTS` | gateway | runtime config | OS-delimiter-separated workspace roots; runtime `--allowed-root` is preferred |
| `SELFHOST_DEVICE_TOKEN` | both | none | Required device authentication |
| `SELFHOST_OWNER_TOKEN` | gateway | none | MCP bearer authentication |
| `SELFHOST_ALLOW_NOAUTH` | gateway | `false` | Loopback-only no-auth MCP mode |
| `SELFHOST_PUBLIC_BASE_URL` | gateway | runtime config | Canonical HTTPS origin used for OAuth discovery/resources |
| `SELFHOST_OAUTH_REDIRECT_URIS` | gateway | Claude callback | Optional comma-separated additional exact OAuth callbacks |
| `SELFHOST_CALL_TIMEOUT_MS` | gateway | `120000` | Routed call timeout |
| `SELFHOST_DELIVERY_LEASE_MS` | gateway | `45000` | Retry lease for lost delivery |
| `SELFHOST_AUDIT_LOG` | gateway | user profile | Metadata-only JSONL audit log |
| `SELFHOST_MAX_BODY_BYTES` | gateway | `33554432` | HTTP request-body ceiling in bytes |
| `SELFHOST_GATEWAY_URL` | device | localhost gateway | Gateway base URL |
| `SELFHOST_DEVICE_ID` | device | persisted UUID | Optional fixed device ID |
| `SELFHOST_DEVICE_NAME` | device | hostname | Display name |

These are operational limits, not usage quotas. The body and timeout controls exist
to keep individual requests bounded and recoverable.

## Current milestone

The first working milestone supports:

- standard MCP Streamable HTTP
- dynamic forwarding of Desktop Commander tools
- one or more personal devices
- outbound device connectivity
- bearer-token device authentication
- private owner-bearer MCP authentication
- standards-oriented OAuth discovery + authorization-code/PKCE flow for public connectors
- bounded pending OAuth authorization-code cache
- split private core/public OAuth-MCP facade; device/control APIs never enter the public tunnel
- HTTPS publication through an external tunnel while both listeners stay loopback-only
- independent gateway workspace-root enforcement in addition to upstream file validation
- remote-only tool-surface reduction and remote-owned PID enforcement
- hidden Windows logon supervisor with child restart
- duplicate-delivery protection
- generated owner/device credentials stored outside the repository
- metadata-only audit receipts
- local usage analytics with today/month/all-time aggregation, per-tool counts, hourly activity, recent terminal events, and service health
- loopback-only usage dashboard; analytics APIs remain private and are not exposed through Funnel
- restart recovery that marks unresolved calls as abandoned/unknown
- graceful shutdown that refuses new work and releases waiting requests
- automatic device re-registration after gateway restart
- no hosted Desktop Commander service dependency in the call path

Gateway routing state is intentionally in memory. A gateway restart never blindly
replays an in-flight side-effecting call. The audit ledger records it as abandoned
with unknown execution state so the caller can make an explicit, tool-aware retry decision.
