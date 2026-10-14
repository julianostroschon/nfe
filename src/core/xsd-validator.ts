import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Validação de XML contra os esquemas oficiais da NFS-e Nacional, versionados em
 * `schemas/`.
 *
 * Vive fora de `tests/` porque não é só ferramenta de teste: o simulador do
 * Emissor Nacional usa a mesma validação para recusar DPS e pedido de evento
 * malformados, que é o que faz o simulador valer algo.
 *
 * É a garantia de leiaute mais forte disponível sem acesso ao ambiente de
 * homologação do fisco, que exige certificado ICP-Brasil real e credenciamento.
 * Pega erro de estrutura, ordem de elemento, tipo, cardinalidade e formato —
 * exatamente a classe de erro que, sem isso, só apareceria como rejeição.
 *
 * Usa `xmllint` (libxml2). API, simulador e testes exigem o binário e os
 * schemas completos; infraestrutura ausente impede a execução.
 */

const SCHEMA_DIR = resolve(
  process.env.NFSE_SCHEMA_DIR ?? resolve(process.cwd(), 'schemas', 'v1.01'),
);

export const DPS_SCHEMA = join(SCHEMA_DIR, 'DPS_v1.01.xsd');

/**
 * Esquema do pedido de registro de evento — o documento do cancelamento
 * (`e101101`). É outro esquema, e não um trecho do da DPS: o `pedRegEvento` tem
 * raiz própria, e validar contra o esquema errado passaria batido.
 */
export const PED_REG_EVENTO_SCHEMA = join(SCHEMA_DIR, 'pedRegEvento_v1.01.xsd');

export interface XsdValidationResult {
  valid: boolean;
  /** Saída do validador, já sem os defeitos conhecidos do esquema. */
  errors: string;
  /** Saída bruta, para diagnóstico. */
  rawErrors: string;
}

/**
 * Defeitos conhecidos do esquema oficial v1.01, que nenhum documento válido
 * consegue satisfazer. São ignorados na validação — mas listados aqui, um por
 * um, com o motivo, para que "ignorar erro de schema" nunca seja genérico.
 *
 * **`TSSerieDPS`** declara `pattern value="^0{0,4}\d{1,5}$"`. Em XML Schema o
 * pattern é ancorado implicitamente e `^`/`$` são **caracteres literais**, não
 * âncoras (W3C XML Schema Part 2, apêndice F). O resultado é que o único valor
 * aceito pelo facet é a string literal `^1$` — verificado com libxml2: `1`,
 * `00001` e `12345` todos falham, `^1$` passa. É erro de redação do esquema, não
 * do nosso documento: emitir `^1$` seria absurdo e o serviço real recusaria.
 *
 * Se uma versão futura do esquema corrigir isto, o teste que garante que a lista
 * ainda é necessária vai falhar, e a entrada sai daqui.
 */
const KNOWN_SCHEMA_DEFECTS = [
  {
    field: 'serie',
    facet: 'pattern',
    reason:
      'TSSerieDPS usa ^ e $ como se fossem âncoras; em XSD são literais, então nenhum valor de série real valida',
  },
] as const;

/**
 * Remove das mensagens apenas os defeitos catalogados acima, casando por campo e
 * facet. Qualquer outro erro passa — a intenção é não deixar um defeito conhecido
 * esconder um erro nosso.
 */
export function filterKnownDefects(errors: string): string {
  return errors
    .split('\n')
    .filter((line) => {
      if (!line.includes('Schemas validity error')) {
        // Linhas de resumo ("fails to validate") só importam se sobrou erro real.
        return !line.includes('fails to validate') && line.trim().length > 0;
      }
      return !KNOWN_SCHEMA_DEFECTS.some(
        (defect) =>
          line.includes(`}${defect.field}'`) && line.includes(`[facet '${defect.facet}']`),
      );
    })
    .join('\n')
    .trim();
}

let cachedAvailability: boolean | null = null;

/** `xmllint` disponível nesta máquina. */
export function isXmlLintAvailable(): boolean {
  if (cachedAvailability !== null) {
    return cachedAvailability;
  }

  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    cachedAvailability = true;
  } catch {
    cachedAvailability = false;
  }

  return cachedAvailability;
}

/**
 * Valida o XML contra o esquema. Lança quando `xmllint` não está disponível —
 * API e simulador verificam a disponibilidade ao iniciar; o setup dos testes
 * também exige a ferramenta antes de executar a suíte.
 */
export function validateAgainstXsd(
  xml: string,
  schemaPath: string = DPS_SCHEMA,
): XsdValidationResult {
  if (!isXmlLintAvailable()) {
    throw new Error(
      'xmllint não encontrado: instale libxml2 (macOS já tem; Debian/Ubuntu: libxml2-utils)',
    );
  }

  const dir = mkdtempSync(join(tmpdir(), 'nfse-xsd-'));
  const file = join(dir, 'document.xml');
  writeFileSync(file, xml, 'utf8');

  try {
    execFileSync('xmllint', ['--noout', '--schema', schemaPath, file], {
      stdio: 'pipe',
    });
    return { valid: true, errors: '', rawErrors: '' };
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? '';
    const raw = stderr.trim();
    const errors = filterKnownDefects(raw);
    const onlyKnownDefect = errors === '' && raw.includes('Schemas validity error');
    return {
      valid: onlyKnownDefect,
      errors: errors || (onlyKnownDefect ? '' : 'Validação XML falhou sem diagnóstico'),
      rawErrors: raw,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
