import { mkdirSync, writeFileSync } from 'node:fs';
import { createTestPkcs12 } from '../src/certificates/tests/pkcs12.fixture';
const cnpj = process.argv[2];
if (!/^\d{14}$/.test(cnpj ?? '')) throw new Error('Informe CNPJ com 14 dígitos');
mkdirSync('tmp/certificados-teste', { recursive: true });
writeFileSync(
  'tmp/certificados-teste/valido.pfx',
  createTestPkcs12({ cnpj, companyName: 'EMPRESA TESTE LTDA', password: 'teste123' }),
  { mode: 0o600 },
);
console.log('Certificado sintético: tmp/certificados-teste/valido.pfx; senha de teste: teste123');
