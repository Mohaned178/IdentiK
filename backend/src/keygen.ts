import { exportJWK, generateKeyPair } from 'jose';

async function main(): Promise<void> {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(privateKey);
  process.stdout.write(`${JSON.stringify([jwk])}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
