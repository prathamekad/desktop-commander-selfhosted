import crypto from 'crypto';

export interface OAuthConfig {
  issuer: string;
  resource: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  redirectUris: string[];
}

interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  connector: OAuthConnector;
  expiresAt: number;
}

export type OAuthConnector = 'chatgpt' | 'claude' | 'other' | 'unknown';

export interface TokenPayload {
  typ: 'access' | 'refresh';
  clientId: string;
  resource: string;
  scope: string;
  connector?: OAuthConnector;
  iat: number;
  exp: number;
  jti: string;
}

const CODE_TTL_MS = 5 * 60_000;
const MAX_PENDING_AUTH_CODES = 256;
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function normalizeUrl(value: string): string {
  return new URL(value).toString();
}

function connectorFromRedirectUri(value: string): OAuthConnector {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) return 'chatgpt';
    if (host === 'claude.ai' || host.endsWith('.claude.ai')) return 'claude';
    return 'other';
  } catch {
    return 'unknown';
  }
}

export class PersonalOAuth {
  private codes = new Map<string, AuthorizationCodeRecord>();

  constructor(private readonly config: OAuthConfig) {}

  protectedResourceMetadata() {
    return {
      resource: this.config.resource,
      authorization_servers: [this.config.issuer],
      scopes_supported: ['mcp:tools'],
      bearer_methods_supported: ['header'],
      resource_name: 'SETU'
    };
  }

  authorizationServerMetadata() {
    return {
      issuer: this.config.issuer,
      authorization_endpoint: new URL('/oauth/authorize', this.config.issuer).toString(),
      token_endpoint: new URL('/oauth/token', this.config.issuer).toString(),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: ['mcp:tools'],
      authorization_response_iss_parameter_supported: true
    };
  }
  authorize(params: URLSearchParams): string {
    const responseType = params.get('response_type') ?? '';
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const codeChallenge = params.get('code_challenge') ?? '';
    const codeChallengeMethod = params.get('code_challenge_method') ?? '';
    const state = params.get('state');
    const requestedScope = params.get('scope') ?? 'mcp:tools';
    const requestedResource = params.get('resource') ?? this.config.resource;

    if (responseType !== 'code') throw new OAuthRequestError('unsupported_response_type');
    if (!safeEqual(clientId, this.config.clientId)) throw new OAuthRequestError('unauthorized_client');
    if (!this.config.redirectUris.includes(normalizeUrl(redirectUri))) {
      throw new OAuthRequestError('invalid_request', 'Unregistered redirect_uri');
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      throw new OAuthRequestError('invalid_request', 'PKCE S256 is required');
    }
    if (requestedScope.split(/\s+/).some((scope) => scope !== 'mcp:tools')) {
      throw new OAuthRequestError('invalid_scope');
    }
    if (normalizeUrl(requestedResource) !== normalizeUrl(this.config.resource)) {
      throw new OAuthRequestError('invalid_target', 'Unexpected resource');
    }

    this.sweepCodes();
    while (this.codes.size >= MAX_PENDING_AUTH_CODES) {
      const oldest = this.codes.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.codes.delete(oldest);
    }

    const code = crypto.randomBytes(32).toString('base64url');
    this.codes.set(code, {
      clientId,
      redirectUri: normalizeUrl(redirectUri),
      codeChallenge,
      scope: 'mcp:tools',
      resource: this.config.resource,
      connector: connectorFromRedirectUri(redirectUri),
      expiresAt: Date.now() + CODE_TTL_MS
    });
    this.sweepCodes();

    const callback = new URL(redirectUri);
    callback.searchParams.set('code', code);
    if (state) callback.searchParams.set('state', state);
    callback.searchParams.set('iss', this.config.issuer);
    return callback.toString();
  }
  exchangeAuthorizationCode(form: URLSearchParams, authHeader?: string): Record<string, unknown> {
    this.assertClient(form, authHeader);

    const code = form.get('code') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';
    const verifier = form.get('code_verifier') ?? '';
    const resource = form.get('resource') ?? this.config.resource;
    const record = this.codes.get(code);

    if (!record || record.expiresAt < Date.now()) {
      this.codes.delete(code);
      throw new OAuthRequestError('invalid_grant');
    }
    this.codes.delete(code);

    if (!safeEqual(record.clientId, this.config.clientId)) throw new OAuthRequestError('invalid_grant');
    if (normalizeUrl(redirectUri) !== record.redirectUri) throw new OAuthRequestError('invalid_grant');
    if (normalizeUrl(resource) !== normalizeUrl(record.resource)) throw new OAuthRequestError('invalid_target');

    const actualChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!safeEqual(actualChallenge, record.codeChallenge)) throw new OAuthRequestError('invalid_grant');

    return this.issueTokenPair(record.scope, record.resource, record.connector);
  }

  refresh(form: URLSearchParams, authHeader?: string): Record<string, unknown> {
    this.assertClient(form, authHeader);
    const refreshToken = form.get('refresh_token') ?? '';
    const payload = this.verifyToken(refreshToken, 'refresh');
    if (!payload) throw new OAuthRequestError('invalid_grant');
    if (!safeEqual(payload.clientId, this.config.clientId)) throw new OAuthRequestError('invalid_grant');

    const requestedScope = form.get('scope');
    const scope = requestedScope ?? payload.scope;
    if (scope.split(/\s+/).some((item) => item !== 'mcp:tools')) {
      throw new OAuthRequestError('invalid_scope');
    }
    return this.issueTokenPair(scope, payload.resource, payload.connector ?? 'unknown');
  }
  verifyAccessToken(token: string): TokenPayload | null {
    return this.verifyToken(token, 'access');
  }

  private issueTokenPair(
    scope: string,
    resource: string,
    connector: OAuthConnector
  ): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    const access = this.signToken({
      typ: 'access',
      clientId: this.config.clientId,
      resource,
      scope,
      connector,
      iat: now,
      exp: now + ACCESS_TTL_SECONDS,
      jti: crypto.randomUUID()
    });
    const refresh = this.signToken({
      typ: 'refresh',
      clientId: this.config.clientId,
      resource,
      scope,
      connector,
      iat: now,
      exp: now + REFRESH_TTL_SECONDS,
      jti: crypto.randomUUID()
    });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refresh,
      scope
    };
  }

  private signToken(payload: TokenPayload): string {
    const encoded = base64url(JSON.stringify(payload));
    const signature = crypto.createHmac('sha256', this.config.signingSecret)
      .update(encoded)
      .digest('base64url');
    return `${encoded}.${signature}`;
  }

  private verifyToken(token: string, expectedType: TokenPayload['typ']): TokenPayload | null {
    const [encoded, signature, extra] = token.split('.');
    if (!encoded || !signature || extra) return null;
    const expected = crypto.createHmac('sha256', this.config.signingSecret)
      .update(encoded)
      .digest('base64url');
    if (!safeEqual(signature, expected)) return null;

    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenPayload;
      const now = Math.floor(Date.now() / 1000);
      if (payload.typ !== expectedType || payload.exp <= now || payload.iat > now + 60) return null;
      if (!safeEqual(payload.clientId, this.config.clientId)) return null;
      if (normalizeUrl(payload.resource) !== normalizeUrl(this.config.resource)) return null;
      return payload;
    } catch {
      return null;
    }
  }
  private assertClient(form: URLSearchParams, authHeader?: string): void {
    let clientId = form.get('client_id') ?? '';
    let clientSecret = form.get('client_secret') ?? '';

    if (authHeader?.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator >= 0) {
          clientId = decodeURIComponent(decoded.slice(0, separator));
          clientSecret = decodeURIComponent(decoded.slice(separator + 1));
        }
      } catch {
        throw new OAuthRequestError('invalid_client');
      }
    }

    if (!safeEqual(clientId, this.config.clientId) || !safeEqual(clientSecret, this.config.clientSecret)) {
      throw new OAuthRequestError('invalid_client');
    }
  }

  private sweepCodes(): void {
    const now = Date.now();
    for (const [code, record] of this.codes) {
      if (record.expiresAt < now) this.codes.delete(code);
    }
  }
}

export class OAuthRequestError extends Error {
  constructor(
    public readonly oauthError: string,
    message?: string
  ) {
    super(message ?? oauthError);
  }
}
