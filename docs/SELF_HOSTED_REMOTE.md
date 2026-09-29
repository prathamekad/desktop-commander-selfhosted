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
- MCP requests require `SELFHOST_OWNER_TOKEN` unless no-auth is explicitly enabled.
- No-auth mode is refused unless the gateway is bound to loopback.
- Self-hosted device mode disables upstream Desktop Commander telemetry.
- Audit logs contain routing metadata only, not tool arguments or tool results.
- A persistent attempted-call journal blocks duplicate execution after delivery retries.
- Existing Desktop Commander allowed-directory and blocked-command controls remain active.

Do not expose the development HTTP listener directly to the public internet. Put TLS
and appropriate access control in front of it, or use a supported private MCP tunnel.

## Build

```powershell
npm ci
npm run build
```

## Local single-machine test

Generate a strong device token. In terminal 1:

```powershell
$env:SELFHOST_DEVICE_TOKEN="<random-secret>"
$env:SELFHOST_ALLOW_NOAUTH="true"
npm run selfhost:gateway
```

No-auth is safe here only because the gateway defaults to loopback.
In terminal 2:

```powershell
$env:SELFHOST_DEVICE_TOKEN="<same-random-secret>"
$env:SELFHOST_GATEWAY_URL="http://127.0.0.1:8787"
npm run selfhost:device
```

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
| `SELFHOST_PORT` | gateway | `8787` | HTTP/MCP port |
| `SELFHOST_DEVICE_TOKEN` | both | none | Required device authentication |
| `SELFHOST_OWNER_TOKEN` | gateway | none | MCP bearer authentication |
| `SELFHOST_ALLOW_NOAUTH` | gateway | `false` | Loopback-only no-auth MCP mode |
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
- optional bearer-token MCP authentication
- duplicate-delivery protection
- metadata-only audit receipts
- automatic device re-registration after gateway restart
- no hosted Desktop Commander service dependency in the call path

Gateway queues are currently in memory. A gateway process restart therefore abandons
calls that were already in flight. Durable queue recovery is a later hardening step.
