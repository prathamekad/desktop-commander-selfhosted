import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function signAccessToken({ clientId, resource, signingSecret }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    typ: 'access',
    clientId,
    resource,
    scope: 'mcp:tools',
    iat: now,
    exp: now + 3600,
    jti: crypto.randomUUID()
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', signingSecret)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

async function waitForHealth(url, child) {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`public proxy exited early: ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('public proxy did not become healthy');
}
const internalPort = await freePort();
const publicPort = await freePort();
const publicBase = 'https://public-proxy-test.example';
const clientId = 'proxy-test-client';
const clientSecret = 'proxy-test-secret';
const signingSecret = 'proxy-test-signing-secret';

const seen = [];
const internal = http.createServer(async (req, res) => {
  seen.push({ method: req.method, url: req.url });
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(Buffer.concat(chunks).length
    ? Buffer.concat(chunks)
    : Buffer.from(JSON.stringify({ ok: true })));
});
internal.listen(internalPort, '127.0.0.1');
await once(internal, 'listening');

const child = spawn(process.execPath, ['dist/selfhost/public-proxy.js'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SELFHOST_PORT: String(internalPort),
    SELFHOST_PUBLIC_PORT: String(publicPort),
    SELFHOST_PUBLIC_BASE_URL: publicBase,
    SELFHOST_OAUTH_CLIENT_ID: clientId,
    SELFHOST_OAUTH_CLIENT_SECRET: clientSecret,
    SELFHOST_OAUTH_SIGNING_SECRET: signingSecret
  }
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  await waitForHealth(`http://127.0.0.1:${publicPort}/healthz`, child);

  const deviceApi = await fetch(`http://127.0.0.1:${publicPort}/api/device/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(deviceApi.status, 404);

  const devicesApi = await fetch(`http://127.0.0.1:${publicPort}/api/devices`);
  assert.equal(devicesApi.status, 404);

  const internalDeviceHits = seen.filter(({ url }) =>
    url?.startsWith('/api/device') || url === '/api/devices'
  );
  assert.equal(internalDeviceHits.length, 0);

  const badMcp = await fetch(`http://127.0.0.1:${publicPort}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer owner-token-must-not-work-publicly',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
  });
  assert.equal(badMcp.status, 401);
  const accessToken = signAccessToken({
    clientId,
    resource: `${publicBase}/mcp`,
    signingSecret
  });
  const goodMcp = await fetch(`http://127.0.0.1:${publicPort}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 })
  });
  assert.equal(goodMcp.status, 200);
  assert.ok(seen.some(({ url }) => url === '/mcp'));

  const discovery = await fetch(
    `http://127.0.0.1:${publicPort}/.well-known/oauth-protected-resource`
  );
  assert.equal(discovery.status, 200);
  assert.ok(seen.some(({ url }) => url === '/.well-known/oauth-protected-resource'));

  console.log('selfhost public proxy: PASS');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill();
  await new Promise((resolve) => internal.close(resolve));
  if (stderr.trim()) process.stderr.write(stderr);
}
