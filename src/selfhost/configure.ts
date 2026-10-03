import { loadRuntimeConfig, RUNTIME_CONFIG_PATH, saveRuntimeConfig } from './runtime-config.js';

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function valuesAfter(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === flag) values.push(process.argv[i + 1]);
  }
  return values;
}

const clearPublic = process.argv.includes('--clear-public-base');
const publicBase = valueAfter('--public-base');
const gatewayUrl = valueAfter('--gateway-url');
const host = valueAfter('--host');
const portRaw = valueAfter('--port');
const publicPortRaw = valueAfter('--public-port');
const dashboardPortRaw = valueAfter('--dashboard-port');
const allowedRoots = valuesAfter('--allowed-root');
const readOnlyRoots = valuesAfter('--read-only-root');
const shutdownWatchScript = valueAfter('--shutdown-watch-script');
const oauthRedirectUris = valuesAfter('--oauth-redirect-uri');

const current = await loadRuntimeConfig();

if (clearPublic) delete current.publicBaseUrl;
if (publicBase) {
  const parsed = new URL(publicBase);
  if (parsed.protocol !== 'https:') throw new Error('--public-base must use https://');
  current.publicBaseUrl = parsed.origin;
}
if (gatewayUrl) current.gatewayUrl = new URL(gatewayUrl).toString().replace(/\/$/, '');
if (host) current.host = host;
if (portRaw) {
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--port must be an integer from 1 to 65535');
  }
  current.port = port;
}
if (publicPortRaw) {
  const publicPort = Number(publicPortRaw);
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
    throw new Error('--public-port must be an integer from 1 to 65535');
  }
  current.publicPort = publicPort;
}
if (dashboardPortRaw) {
  const dashboardPort = Number(dashboardPortRaw);
  if (!Number.isInteger(dashboardPort) || dashboardPort < 1 || dashboardPort > 65535) {
    throw new Error('--dashboard-port must be an integer from 1 to 65535');
  }
  current.dashboardPort = dashboardPort;
}
if (allowedRoots.length > 0) {
  current.allowedRoots = [...new Set(allowedRoots)];
}
if (readOnlyRoots.length > 0) {
  current.readOnlyRoots = [...new Set(readOnlyRoots)];
}
if (shutdownWatchScript) {
  current.shutdownWatchScript = shutdownWatchScript;
}
if (oauthRedirectUris.length > 0) {
  current.oauthRedirectUris = [...new Set(
    oauthRedirectUris.map((value) => new URL(value).toString())
  )];
}

await saveRuntimeConfig(current);
console.log(`Saved runtime configuration: ${RUNTIME_CONFIG_PATH}`);
console.log(JSON.stringify(current, null, 2));
