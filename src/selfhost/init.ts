import { initializeSecrets } from './credentials.js';

const force = process.argv.includes('--force');

initializeSecrets(force)
  .then(({ gatewayPath, devicePath, created }) => {
    console.log(created ? 'Created self-hosted credentials.' : 'Self-hosted credentials already exist.');
    console.log(`Gateway secrets: ${gatewayPath}`);
    console.log(`Device secret:    ${devicePath}`);
    console.log('Secrets were not printed.');
    console.log('Copy only device-secret.json to another personal device; do not copy gateway-secrets.json.');
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
