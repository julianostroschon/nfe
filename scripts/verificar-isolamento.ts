import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Fragmentos evitam que a própria lista de busca produza um falso positivo.
const forbidden = new RegExp(
  [
    'pa' + 'ciente',
    'pat' + 'ient',
    'stu' + 'dy',
    'stu' + 'dies',
    'ex' + 'am',
    'insur' + 'ance',
    'con' + 'venio',
    'bil' + 'ling',
    'recei' + 'vable',
    'cli' + 'nic',
    'R' + 'IS-',
    'proce' + 'dimento',
    'proce' + 'dure',
    'aten' + 'dimento',
  ].join('|'),
  'i',
);
const excluded = new Set(['node_modules', 'dist', 'tmp', 'coverage', '.git', '.env']);
const matches: string[] = [];
function scan(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (entry.isFile()) {
      const text = readFileSync(file, 'utf8');
      if (forbidden.test(text)) matches.push(file);
    }
  }
}
scan(process.cwd());
if (matches.length) {
  console.error('Acoplamento externo encontrado em: ' + matches.join(', '));
  process.exitCode = 1;
} else
  console.log(
    'Isolamento validado: busca de termos externos sem ocorrências nos artefatos do serviço.',
  );
