import http, { IncomingMessage, ServerResponse } from 'http';
import { loadGatewaySecrets } from './credentials.js';
import { PersonalOAuth } from './oauth.js';
import { loadRuntimeConfig } from './runtime-config.js';

const PUBLIC_GET = new Set([
  '/healthz',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/oauth/authorize'
]);

const PUBLIC_POST = new Set([
  '/oauth/token',
  '/mcp'
]);

function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...headers
  });
  res.end(payload);
}

function routeAllowed(method: string, pathname: string): boolean {
  if (method === 'GET') return PUBLIC_GET.has(pathname);
  if (method === 'POST') return PUBLIC_POST.has(pathname);
  return false;
}

function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  internalPort: number
): void {
  const headers = { ...req.headers };
  delete headers.connection;
  delete headers['proxy-connection'];
  headers.host = `127.0.0.1:${internalPort}`;

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: internalPort,
    path: req.url,
    method: req.method,
    headers
  }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers };
    delete responseHeaders.connection;
    res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(res);
  });

  upstream.on('error', (error) => {
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'private_gateway_unavailable' });
    } else {
      res.end();
    }
    console.error('[public-proxy] upstream error:', error.message);
  });

  req.pipe(upstream);
}
async function main(): Promise<void> {
  const runtime = await loadRuntimeConfig();
  const secrets = await loadGatewaySecrets();
  const publicBase = process.env.SELFHOST_PUBLIC_BASE_URL ?? runtime.publicBaseUrl;
  const internalPort = Number(process.env.SELFHOST_PORT ?? runtime.port ?? 8787);
  const publicPort = Number(process.env.SELFHOST_PUBLIC_PORT ?? runtime.publicPort ?? 8788);
  const oauthClientId = process.env.SELFHOST_OAUTH_CLIENT_ID ?? secrets?.oauthClientId;
  const oauthClientSecret = process.env.SELFHOST_OAUTH_CLIENT_SECRET ?? secrets?.oauthClientSecret;
  const oauthSigningSecret = process.env.SELFHOST_OAUTH_SIGNING_SECRET ?? secrets?.oauthSigningSecret;

  if (!publicBase) throw new Error('publicBaseUrl is required for the public MCP proxy');
  if (!oauthClientId || !oauthClientSecret || !oauthSigningSecret) {
    throw new Error('OAuth secrets are missing');
  }
  if (!Number.isInteger(internalPort) || !Number.isInteger(publicPort)) {
    throw new Error('Gateway/public ports must be integers');
  }

  const oauth = new PersonalOAuth({
    issuer: publicBase,
    resource: `${publicBase}/mcp`,
    clientId: oauthClientId,
    clientSecret: oauthClientSecret,
    signingSecret: oauthSigningSecret,
    redirectUris: [
      'https://claude.ai/api/mcp/auth_callback',
      'https://chatgpt.com/connector_platform_oauth_redirect',
      ...(runtime.oauthRedirectUris ?? []),
      ...(process.env.SELFHOST_OAUTH_REDIRECT_URIS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    ].map((value) => new URL(value).toString())
  });

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (!routeAllowed(method, url.pathname)) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (method === 'GET' && url.pathname === '/healthz') {
      const check = http.get(
        { hostname: '127.0.0.1', port: internalPort, path: '/healthz' },
        (upstream) => {
          upstream.resume();
          sendJson(res, upstream.statusCode === 200 ? 200 : 503, {
            ok: upstream.statusCode === 200,
            service: 'desktop-commander-selfhosted-public'
          });
        }
      );
      check.setTimeout(2_000, () => check.destroy(new Error('timeout')));
      check.on('error', () => {
        if (!res.headersSent) {
          sendJson(res, 503, {
            ok: false,
            service: 'desktop-commander-selfhosted-public'
          });
        }
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/mcp') {
      const token = bearerToken(req.headers.authorization);
      if (!token || !oauth.verifyAccessToken(token)) {
        sendJson(res, 401, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'OAuth access token required' },
          id: null
        }, {
          'www-authenticate':
            `Bearer resource_metadata="${publicBase}/.well-known/oauth-protected-resource", scope="mcp:tools"`
        });
        return;
      }
    }

    proxyRequest(req, res, internalPort);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(publicPort, '127.0.0.1', () => {
      server.off('error', onError);
      console.log('SETU Public MCP Proxy');
      console.log(`  Public facade: http://127.0.0.1:${publicPort}`);
      console.log(`  Private core:  http://127.0.0.1:${internalPort}`);
      console.log('  Exposed routes: OAuth discovery/token + POST /mcp + health');
      resolve();
    });
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
