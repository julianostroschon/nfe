import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
if (existsSync('.env'))
  throw new Error('.env já existe; preservado. Use outro diretório para um ambiente novo');
const apiKey = randomBytes(32).toString('hex');
const password = randomBytes(24).toString('hex');
const rootPassword = randomBytes(24).toString('hex');
const cnpjs = ['12345678000195', '98765432000198'];
writeFileSync(
  '.env',
  [
    'PORT=3000',
    `DATABASE_URL=mysql://fiscal:${password}@127.0.0.1:3307/fiscal`,
    'REDIS_URL=redis://127.0.0.1:6380',
    `MYSQL_PASSWORD=${password}`,
    `MYSQL_ROOT_PASSWORD=${rootPassword}`,
    'MYSQL_PORT=3307',
    'REDIS_PORT=6380',
    `CREDENTIALS_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
    `API_KEY_HASHES_JSON=${JSON.stringify([{ sha256: createHash('sha256').update(apiKey).digest('hex'), cnpjs }])}`,
    'NFSE_ENVIRONMENT=HOMOLOGATION',
    '',
  ].join('\n'),
  { mode: 0o600 },
);
mkdirSync('tmp', { recursive: true });
writeFileSync('tmp/acesso-teste.json', JSON.stringify({ apiKey, cnpjs }, null, 2) + '\n', {
  mode: 0o600,
});
console.log(
  'Ambiente sintético criado. Chave de acesso em tmp/acesso-teste.json; .env preservado fora do versionamento.',
);
