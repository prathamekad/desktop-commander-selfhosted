import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PersonalOAuth } from '../dist/selfhost/oauth.js';

const oauth = new PersonalOAuth({
  issuer: 'https://example.test',
  resource: 'https://example.test/mcp',
  clientId: 'client-test',
  clientSecret: 'secret-test',
  signingSecret: 'signing-secret-test',
  redirectUris: ['https://claude.ai/api/mcp/auth_callback']
});

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const authorize = new URLSearchParams({
  response_type: 'code',
  client_id: 'client-test',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: 'state-test',
  scope: 'mcp:tools',
  resource: 'https://example.test/mcp'
});

const redirect = new URL(oauth.authorize(authorize));
assert.equal(redirect.origin + redirect.pathname, 'https://claude.ai/api/mcp/auth_callback');
assert.equal(redirect.searchParams.get('state'), 'state-test');
assert.equal(redirect.searchParams.get('iss'), 'https://example.test');
const code = redirect.searchParams.get('code');
assert.ok(code);

const basic = 'Basic ' + Buffer.from(
  encodeURIComponent('client-test') + ':' + encodeURIComponent('secret-test')
).toString('base64');

const exchange = new URLSearchParams({
  grant_type: 'authorization_code',
  code,
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_verifier: verifier,
  resource: 'https://example.test/mcp'
});
const tokens = oauth.exchangeAuthorizationCode(exchange, basic);
assert.equal(tokens.token_type, 'Bearer');
assert.ok(tokens.access_token);
assert.ok(tokens.refresh_token);
assert.ok(oauth.verifyAccessToken(tokens.access_token));

assert.throws(() => oauth.exchangeAuthorizationCode(exchange, basic), /invalid_grant/);

const refresh = new URLSearchParams({
  grant_type: 'refresh_token',
  refresh_token: tokens.refresh_token
});
const refreshed = oauth.refresh(refresh, basic);
assert.ok(refreshed.access_token);
assert.ok(oauth.verifyAccessToken(refreshed.access_token));

const badRedirect = new URLSearchParams(authorize);
badRedirect.set('redirect_uri', 'https://attacker.example/callback');
assert.throws(() => oauth.authorize(badRedirect), /Unregistered redirect_uri/);

console.log('selfhost oauth: PASS');
