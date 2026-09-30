import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PersonalOAuth } from '../dist/selfhost/oauth.js';

const oauth = new PersonalOAuth({
  issuer: 'https://example.test',
  resource: 'https://example.test/mcp',
  clientId: 'client-test',
  clientSecret: 'secret-test',
  signingSecret: 'signing-secret-test',
  redirectUris: [
    'https://claude.ai/api/mcp/auth_callback',
    'https://chatgpt.com/connector_platform_oauth_redirect'
  ]
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
const claudeAccess = oauth.verifyAccessToken(tokens.access_token);
assert.ok(claudeAccess);
assert.equal(claudeAccess.connector, 'claude');

assert.throws(() => oauth.exchangeAuthorizationCode(exchange, basic), /invalid_grant/);

const refresh = new URLSearchParams({
  grant_type: 'refresh_token',
  refresh_token: tokens.refresh_token
});
const refreshed = oauth.refresh(refresh, basic);
assert.ok(refreshed.access_token);
const refreshedAccess = oauth.verifyAccessToken(refreshed.access_token);
assert.ok(refreshedAccess);
assert.equal(refreshedAccess.connector, 'claude');

const chatgptVerifier = crypto.randomBytes(32).toString('base64url');
const chatgptChallenge = crypto.createHash('sha256').update(chatgptVerifier).digest('base64url');
const chatgptAuthorize = new URLSearchParams(authorize);
chatgptAuthorize.set('redirect_uri', 'https://chatgpt.com/connector_platform_oauth_redirect');
chatgptAuthorize.set('code_challenge', chatgptChallenge);
const chatgptRedirect = new URL(oauth.authorize(chatgptAuthorize));
const chatgptExchange = new URLSearchParams(exchange);
chatgptExchange.set('code', chatgptRedirect.searchParams.get('code'));
chatgptExchange.set('redirect_uri', 'https://chatgpt.com/connector_platform_oauth_redirect');
chatgptExchange.set('code_verifier', chatgptVerifier);
const chatgptTokens = oauth.exchangeAuthorizationCode(chatgptExchange, basic);
const chatgptAccess = oauth.verifyAccessToken(chatgptTokens.access_token);
assert.ok(chatgptAccess);
assert.equal(chatgptAccess.connector, 'chatgpt');

const badRedirect = new URLSearchParams(authorize);
badRedirect.set('redirect_uri', 'https://attacker.example/callback');
assert.throws(() => oauth.authorize(badRedirect), /Unregistered redirect_uri/);

const boundedOauth = new PersonalOAuth({
  issuer: 'https://example.test',
  resource: 'https://example.test/mcp',
  clientId: 'client-test',
  clientSecret: 'secret-test',
  signingSecret: 'signing-secret-test',
  redirectUris: ['https://claude.ai/api/mcp/auth_callback']
});
let oldestCode = '';
for (let i = 0; i < 257; i++) {
  const callback = new URL(boundedOauth.authorize(authorize));
  if (i === 0) oldestCode = callback.searchParams.get('code');
}
const evictedExchange = new URLSearchParams(exchange);
evictedExchange.set('code', oldestCode);
assert.throws(
  () => boundedOauth.exchangeAuthorizationCode(evictedExchange, basic),
  /invalid_grant/
);

console.log('selfhost oauth: PASS');
