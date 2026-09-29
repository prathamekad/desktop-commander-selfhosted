import { loadGatewaySecrets } from './credentials.js';
import { loadRuntimeConfig } from './runtime-config.js';

const secrets = await loadGatewaySecrets();
const runtime = await loadRuntimeConfig();

if (!secrets?.oauthClientId || !secrets?.oauthClientSecret) {
  throw new Error('OAuth credentials are missing. Run npm run selfhost:init.');
}

console.log('Desktop Commander Self-Hosted connector');
console.log('');
if (runtime.publicBaseUrl) {
  console.log('MCP URL:             ' + runtime.publicBaseUrl.replace(/\/$/, '') + '/mcp');
} else {
  console.log('MCP URL:             NOT CONFIGURED (set --public-base after Funnel is ready)');
}
console.log('OAuth Client ID:     ' + secrets.oauthClientId);
console.log('OAuth Client Secret: ' + secrets.oauthClientSecret);
console.log('OAuth Callback:      https://claude.ai/api/mcp/auth_callback');
console.log('');
console.log('Keep the client secret private. Owner/device tokens are intentionally not shown.');
