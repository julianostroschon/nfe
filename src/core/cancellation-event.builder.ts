import { BadRequestException } from '@nestjs/common';
import {
  digitsOnly,
  element,
  escapeXml,
  formatDateTimeWithOffset,
  LAYOUT_VERSION,
  NAMESPACE,
} from './dps.builder';

/**
 * Montagem do XML do pedido de registro do evento de **cancelamento** de NFS-e
 * (`pedRegEvento`, evento `e101101`) do padrão nacional.
 *
 * Cancelar não altera a nota: o padrão registra um evento novo, vinculado à
 * chave de acesso, e a nota autorizada permanece exatamente como foi declarada.
 * É o mesmo princípio que o `authorized_xml` já guarda no banco — documento
 * fiscal é imutável, e correção é evento, nunca sobrescrita.
 *
 * Escrito contra o XSD oficial v1.01, versionado em
 * `schemas/v1.01/` (`pedRegEvento_v1.01.xsd` e
 * `tiposEventos_v1.01.xsd`). A ordem dos elementos segue a `xs:sequence` de
 * `TCInfPedReg` — em XML Schema a ordem é normativa.
 *
 * Concatenação, e não biblioteca de serialização, pela mesma razão da DPS: o
 * documento é assinado, e a assinatura cobre os bytes exatos.
 */

/** `TSTipoAmbiente`: 1 produção, 2 homologação. Mesmos valores da DPS. */
export const EVENT_ENVIRONMENT = {
  PRODUCTION: '1',
  HOMOLOGATION: '2',
} as const;

export type EventEnvironment = (typeof EVENT_ENVIRONMENT)[keyof typeof EVENT_ENVIRONMENT];

/**
 * Código do evento de cancelamento na composição do `Id`. O elemento é
 * `e101101`; o identificador leva só os seis dígitos.
 */
const CANCELLATION_EVENT_CODE = '101101';

/**
 * `xDesc` é enumeração de valor único no esquema: qualquer outro texto invalida
 * o documento. Não é rótulo para exibição — a justificativa de quem cancela vai
 * em `xMotivo`.
 */
const CANCELLATION_EVENT_DESCRIPTION = 'Cancelamento de NFS-e';

/**
 * `cMotivo` (`TSCodJustCanc`). São os três códigos que o fisco aceita; não há
 * "outro" livre — o detalhe vai no texto.
 */
export const CANCELLATION_REASON_CODE = {
  ISSUE_ERROR: '1',
  SERVICE_NOT_PROVIDED: '2',
  OTHER: '9',
} as const;

export type CancellationReasonCode =
  (typeof CANCELLATION_REASON_CODE)[keyof typeof CANCELLATION_REASON_CODE];

export const CANCELLATION_REASON_CODES = Object.values(
  CANCELLATION_REASON_CODE,
) as CancellationReasonCode[];

/**
 * `xMotivo` é `TSMotivo`: **mínimo 15** e máximo 255 caracteres. O mínimo é do
 * esquema, não escolha nossa, e é o que impede "erro" como justificativa de um
 * cancelamento fiscal.
 */
export const CANCELLATION_REASON_MIN_LENGTH = 15;
export const CANCELLATION_REASON_MAX_LENGTH = 255;

/**
 * Trocas de caracteres que teclado e editor de texto produzem sozinhos e que o
 * leiaute não aceita. Nenhuma muda o sentido do texto.
 */
const TYPOGRAPHIC_REPLACEMENTS: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B]/g, "'"],
  [/[\u201C\u201D\u201E\u201F]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, '-'],
  [/\u2026/g, '...'],
  [/[\u00A0\u2007\u202F]/g, ' '],
];

/**
 * Deixa a justificativa no alfabeto que o leiaute aceita.
 *
 * `TSMotivo` deriva de `TSString`, cujo padrão é
 * `[!-ÿ]{1}[ -ÿ]{0,}[!-ÿ]{1}|[!-ÿ]{1}`: só caracteres de `!` (U+0021) a `ÿ`
 * (U+00FF), com espaço permitido no miolo. Ou seja, **nada de quebra de linha,
 * tabulação ou caractere acima de U+00FF** — e o esquema tem um tipo separado,
 * `TSStringComQuebraDeLinha`, para os campos que aceitam quebra, que não é o
 * caso deste.
 *
 * Sem isto, apertar Enter no campo de motivo — ou colar um texto com travessão
 * e aspas curvas, que editor e navegador produzem sozinhos — gera um documento
 * que o fisco recusa por leiaute. O pior é o desfecho: a recusa entraria no
 * histórico como se o fisco tivesse avaliado o cancelamento, quando ele sequer
 * chegou a ler o pedido. Acentuação continua intacta: `ç`, `ã` e `é` estão
 * dentro da faixa.
 */
export function normalizeCancellationReason(value: string): string {
  let text = value;

  for (const [pattern, replacement] of TYPOGRAPHIC_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }

  return (
    text
      // Primeiro o espaço em branco, e só depois o descarte: quebra de linha e
      // tabulação **separam palavras**, então viram espaço. Descartá-las junto
      // com o resto grudaria as duas palavras vizinhas.
      .replace(/\s+/g, ' ')
      // Controles e tudo acima de U+00FF saem: não há substituto honesto, e
      // adivinhar um mudaria o que a empresa declarou.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: é o que o leiaute proíbe
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/[^\u0020-\u00FF]/g, '')
      // O descarte pode ter deixado dois espaços onde havia um caractere.
      .replace(/ {2,}/g, ' ')
      .trim()
  );
}

export interface CancellationEventInput {
  environment: EventEnvironment;
  /** Momento do pedido, que sai em `dhEvento`. */
  requestedAt: Date;
  /** `verAplic`: versão do aplicativo, até 20 caracteres. */
  applicationVersion: string;
  /** CNPJ do autor do evento — o prestador que emitiu a nota. */
  authorCnpj: string;
  /** Chave de acesso da NFS-e a cancelar: 50 dígitos. */
  accessKey: string;
  reasonCode: CancellationReasonCode;
  /** Justificativa livre, 15 a 255 caracteres. */
  reason: string;
}

export interface BuiltCancellationEvent {
  /** Documento pronto para assinar. */
  xml: string;
  /** Valor do atributo `Id` do `infPedReg`: `PRE` + 56 dígitos. */
  idAttribute: string;
}

/**
 * Monta o identificador do pedido: `PRE` + chave de acesso (50) + código do
 * evento (6), conforme `TSIdPedRegEvt` (`PRE[0-9]{56}`).
 *
 * A documentação do tipo cita também o número do pedido, mas o padrão do
 * atributo não o comporta — 50 mais 6 já fecham os 56 dígitos. Quem carrega o
 * sequencial é o `Id` do **evento registrado** (`TSIdEvento`, 59 dígitos), que é
 * montado pelo fisco na resposta, não por quem pede.
 */
export function buildCancellationEventId(accessKey: string): string {
  const key = digitsOnly(accessKey);
  const id = `${key}${CANCELLATION_EVENT_CODE}`;

  // Erro de programação, não de usuário: chave fora do formato significa que a
  // nota foi gravada com uma chave que o fisco não devolveria.
  if (!/^[0-9]{56}$/.test(id)) {
    throw new Error(
      `Identificador de pedido de evento malformado (${id.length} dígitos); esperados 56 — a chave de acesso precisa ter 50 dígitos`,
    );
  }

  return `PRE${id}`;
}

function assertFormats(input: CancellationEventInput): void {
  if (!/^[0-9]{50}$/.test(digitsOnly(input.accessKey))) {
    throw new BadRequestException(
      'A chave de acesso desta nota não tem os 50 dígitos do padrão nacional; sem ela não há como vincular o cancelamento',
    );
  }

  if (!/^[0-9]{14}$/.test(digitsOnly(input.authorCnpj))) {
    throw new BadRequestException('CNPJ do autor do cancelamento fora do formato: são 14 dígitos');
  }

  // O comprimento vale sobre o texto que **vai sair no documento**, não sobre o
  // que foi digitado: normalizar depois de medir deixaria passar um motivo que
  // encolhe abaixo do mínimo ao perder caracteres.
  const reason = normalizeCancellationReason(input.reason);

  if (reason.length < CANCELLATION_REASON_MIN_LENGTH) {
    throw new BadRequestException(
      `O motivo do cancelamento precisa de pelo menos ${CANCELLATION_REASON_MIN_LENGTH} caracteres — é exigência do layout nacional, não do sistema. Descreva o que aconteceu.`,
    );
  }

  if (reason.length > CANCELLATION_REASON_MAX_LENGTH) {
    throw new BadRequestException(
      `O motivo do cancelamento passa de ${CANCELLATION_REASON_MAX_LENGTH} caracteres, que é o limite do layout nacional`,
    );
  }
}

export function buildCancellationEvent(input: CancellationEventInput): BuiltCancellationEvent {
  assertFormats(input);

  const idAttribute = buildCancellationEventId(input.accessKey);

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<pedRegEvento xmlns="${NAMESPACE}" versao="${LAYOUT_VERSION}">` +
    `<infPedReg Id="${idAttribute}">` +
    element('tpAmb', input.environment) +
    element('verAplic', escapeXml(input.applicationVersion)) +
    element('dhEvento', formatDateTimeWithOffset(input.requestedAt)) +
    element('CNPJAutor', digitsOnly(input.authorCnpj)) +
    element('chNFSe', digitsOnly(input.accessKey)) +
    `<e101101>` +
    element('xDesc', CANCELLATION_EVENT_DESCRIPTION) +
    element('cMotivo', input.reasonCode) +
    element('xMotivo', escapeXml(normalizeCancellationReason(input.reason))) +
    `</e101101>` +
    `</infPedReg>` +
    `</pedRegEvento>`;

  return { xml, idAttribute };
}
