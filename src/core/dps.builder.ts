import { BadRequestException } from '@nestjs/common';

/**
 * Montagem do XML da DPS (Declaração de Prestação de Serviços) do padrão
 * nacional de NFS-e.
 *
 * Escrito contra o XSD oficial v1.01 (pacote de 2026-02-09), versionado em
 * `schemas/v1.01/`. A ordem dos elementos segue a
 * `xs:sequence` de `TCInfDPS` — em XML Schema a ordem é normativa, e trocar dois
 * elementos de lugar invalida o documento mesmo com todo o conteúdo correto.
 *
 * O XML é montado por concatenação, e não por biblioteca de serialização, porque
 * ele é assinado: a assinatura cobre os bytes exatos do documento, então quem
 * monta precisa controlar espaçamento e escaping, sem reformatação no caminho.
 */

export const NAMESPACE = 'http://www.sped.fazenda.gov.br/nfse';
export const LAYOUT_VERSION = '1.01';

/** `TSTipoAmbiente`: 1 produção, 2 homologação. */
export const DPS_ENVIRONMENT = {
  PRODUCTION: '1',
  HOMOLOGATION: '2',
} as const;

export type DpsEnvironment = (typeof DPS_ENVIRONMENT)[keyof typeof DPS_ENVIRONMENT];

/**
 * Tipo de inscrição federal do emitente, na composição do `Id`: 1 CPF, 2 CNPJ.
 * Confirmado no ANEXO_I do leiaute (v1.01) — o XSD não enumera esses valores.
 */
const FEDERAL_REGISTRATION_TYPE_CNPJ = '2';

/** `TSEmitenteDPS`: 1 prestador, 2 tomador, 3 intermediário. */
const ISSUER_TYPE_PROVIDER = '1';

/** `TSTipoRetISSQN`: 1 não retido, 2 retido pelo tomador, 3 pelo intermediário. */
const ISS_RETENTION = { NOT_WITHHELD: '1', WITHHELD_BY_TAKER: '2' } as const;

/**
 * `TSTipoIndTotTrib`: valor fixo `0`. O próprio XSD determina que não se informe
 * valor estimado de tributos (Decreto 8.264/2014), então esta é a única opção do
 * grupo `totTrib` que não exige apurar tributo federal.
 */
const TOTAL_TAX_INDICATOR_NONE = '0';

/** Dados tributários declarados pelo chamador; nenhuma classificação é inferida. */
export interface DpsFiscalClassification {
  /**
   * `cTribNac`: 6 dígitos — item (2) + subitem (2) + desdobro nacional (2) da
   * Lista Nacional de Serviços.
   *
   * Não é derivável apenas do código LC 116: o desdobro é declarado pelo chamador.
   */
  nationalServiceCode: string;
  municipalTaxCode?: string;
  /** `opSimpNac`: 1 não optante, 2 MEI, 3 ME/EPP. */
  simplesNacional: '1' | '2' | '3';
  /** `regApTribSN`: regime de apuração, exigido quando optante do Simples. */
  simplesNacionalRegime?: string | null;
  /** `regEspTrib`: 0 nenhum … 6 sociedade de profissionais, 9 outros. */
  specialTaxRegime: string;
  /** `tribISSQN`: 1 tributável, 2 imunidade, 3 exportação, 4 não incidência. */
  issqnTaxation: '1' | '2' | '3' | '4';
}

/** `opSimpNac` 1: prestador não optante do Simples Nacional. */
const SIMPLES_NAO_OPTANTE = '1';

export interface DpsProvider {
  cnpj: string;
  /** `IM`: inscrição municipal, opcional no layout. */
  municipalRegistration?: string | null;
  /**
   * Razão social do prestador. **Não vai na DPS**: o emitente é sempre o próprio
   * prestador (`tpEmit` 1), e o emissor nacional recusa `xNome` nesse caso
   * (E0121). Fica na interface só para os chamadores que já a preenchem.
   */
  name?: string | null;
}

export interface DpsTaker {
  cnpj: string;
  /** `xNome` é obrigatório quando o grupo `toma` está presente. */
  name: string;
}

export interface DpsInput {
  environment: DpsEnvironment;
  /** `dhEmi`. */
  issuedAt: Date;
  /** `verAplic`: 1 a 20 caracteres. */
  applicationVersion: string;
  /** `serie`: até 5 dígitos. */
  series: string;
  /** `nDPS`: até 15 dígitos, sem zero à esquerda. */
  number: number;
  /** `dCompet`: mês da prestação. */
  competency: Date;
  /** `cLocEmi`: município do emitente, código IBGE. */
  issuerCityCode: number;
  /** `serv/locPrest/cLocPrestacao`: município da prestação. */
  serviceCityCode: number;
  provider: DpsProvider;
  /** Ausente emite sem tomador — o layout permite (`toma` é opcional). */
  taker?: DpsTaker | null;
  /** `xDescServ`: discriminação, no lugar da lista de serviços. */
  serviceDescription: string;
  /** `vServ`: até 15 dígitos e 2 decimais. */
  amount: string;
  /** `pAliq`: 1 dígito e 2 decimais — o layout não aceita alíquota ≥ 10. */
  issRate?: string | null;
  issWithheld: boolean;
  totalTaxPercents?: { federal: string; state: string; municipal: string };
  fiscal: DpsFiscalClassification;
}

export interface BuiltDps {
  /** Documento pronto para assinar. */
  xml: string;
  /** Os 42 dígitos da composição, sem o prefixo `DPS`. */
  dpsId: string;
  /** Valor do atributo `Id`: `DPS` + os 42 dígitos. */
  idAttribute: string;
}

export const digitsOnly = (value: string): string => value.replace(/\D/g, '');

/**
 * `dhEmi` é `TSDateTimeUTC`, e o padrão do layout **não aceita `Z`**: exige
 * deslocamento explícito `±hh:mm` com minutos sempre `00`. Fixado em `-03:00`
 * porque é o fuso da operação; emitir com outro deslocamento mudaria a
 * competência declarada na virada do dia.
 */
const BRAZIL_UTC_OFFSET_HOURS = -3;

export function formatDateTimeWithOffset(date: Date): string {
  const shifted = new Date(date.getTime() + BRAZIL_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const iso = shifted.toISOString().slice(0, 19);
  const sign = BRAZIL_UTC_OFFSET_HOURS < 0 ? '-' : '+';
  const hours = String(Math.abs(BRAZIL_UTC_OFFSET_HOURS)).padStart(2, '0');
  return `${iso}${sign}${hours}:00`;
}

/** `dCompet` é `TSData` (AAAA-MM-DD), sem hora. */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Escapa o que o XML exige. Texto livre vindo da empresa — a discriminação da
 * DPS, a justificativa de um cancelamento — pode conter `&` ou `<`, e sem
 * escapar o documento quebra ou, pior, muda de estrutura.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function element(tag: string, value: string): string {
  return `<${tag}>${value}</${tag}>`;
}

/**
 * Monta o identificador da DPS: `Cód.Mun (7) + Tipo de Inscrição Federal (1) +
 * Inscrição Federal (14) + Série (5) + Número (15)`, 42 dígitos.
 *
 * Regra do ANEXO_I do leiaute. A série e o número são preenchidos com zero à
 * esquerda; o CNPJ já tem 14 dígitos.
 */
export function buildDpsId(params: {
  issuerCityCode: number;
  cnpj: string;
  series: string;
  number: number;
}): string {
  const city = String(params.issuerCityCode).padStart(7, '0');
  const cnpj = digitsOnly(params.cnpj).padStart(14, '0');
  const series = digitsOnly(params.series).padStart(5, '0');
  const number = String(params.number).padStart(15, '0');

  const id = `${city}${FEDERAL_REGISTRATION_TYPE_CNPJ}${cnpj}${series}${number}`;

  // Erro de programação, não de usuário: se a composição não fecha 42 dígitos,
  // algum insumo veio fora do formato e o documento seria recusado no fisco.
  if (!/^[0-9]{42}$/.test(id)) {
    throw new Error(
      `Identificador de DPS malformado (${id.length} caracteres); esperados 42 dígitos`,
    );
  }

  return id;
}

/**
 * Confere os formatos que o XSD impõe e que dependem de dado de configuração.
 * Falhar aqui, com mensagem de negócio, é melhor que transmitir e receber
 * rejeição genérica do fisco.
 */
function assertFormats(input: DpsInput): void {
  if (!/^[0-9]{6}$/.test(input.fiscal.nationalServiceCode)) {
    throw new BadRequestException(
      'Código de tributação nacional inválido: são 6 dígitos (item, subitem e desdobro da Lista Nacional de Serviços)',
    );
  }

  if (!/^(0|0\.[0-9]{2}|[1-9][0-9]{0,14}(\.[0-9]{2})?)$/.test(input.amount)) {
    throw new BadRequestException(
      `Valor do serviço fora do formato aceito pelo layout: "${input.amount}"`,
    );
  }

  // `TSDec1V2` admite um único dígito antes da vírgula: alíquota de 10% ou mais
  // não cabe no layout. Na prática o teto do ISS é 5%, mas o erro precisa ser
  // explícito em vez de virar rejeição.
  if (
    input.issRate !== null &&
    input.issRate !== undefined &&
    !/^(0|[0-9](\.[0-9]{2})?)$/.test(input.issRate)
  ) {
    throw new BadRequestException(
      `Alíquota de ISS fora do formato aceito pelo layout: "${input.issRate}". O padrão nacional aceita um dígito e duas casas (ex.: 5.00)`,
    );
  }
}

export function buildDps(input: DpsInput): BuiltDps {
  assertFormats(input);

  const dpsId = buildDpsId({
    issuerCityCode: input.issuerCityCode,
    cnpj: input.provider.cnpj,
    series: input.series,
    number: input.number,
  });
  const idAttribute = `DPS${dpsId}`;

  const provider =
    `<prest>` +
    element('CNPJ', digitsOnly(input.provider.cnpj)) +
    (input.provider.municipalRegistration
      ? element('IM', escapeXml(input.provider.municipalRegistration))
      : '') +
    `<regTrib>` +
    element('opSimpNac', input.fiscal.simplesNacional) +
    (input.fiscal.simplesNacionalRegime
      ? element('regApTribSN', input.fiscal.simplesNacionalRegime)
      : '') +
    element('regEspTrib', input.fiscal.specialTaxRegime) +
    `</regTrib>` +
    `</prest>`;

  const taker = input.taker
    ? `<toma>` +
      element('CNPJ', digitsOnly(input.taker.cnpj)) +
      element('xNome', escapeXml(input.taker.name)) +
      `</toma>`
    : '';

  const service =
    `<serv>` +
    `<locPrest>` +
    element('cLocPrestacao', String(input.serviceCityCode)) +
    `</locPrest>` +
    `<cServ>` +
    element('cTribNac', input.fiscal.nationalServiceCode) +
    (input.fiscal.municipalTaxCode
      ? element('cTribMun', escapeXml(input.fiscal.municipalTaxCode))
      : '') +
    element('xDescServ', escapeXml(input.serviceDescription)) +
    `</cServ>` +
    `</serv>`;

  const values =
    `<valores>` +
    `<vServPrest>` +
    element('vServ', input.amount) +
    `</vServPrest>` +
    `<trib>` +
    `<tribMun>` +
    element('tribISSQN', input.fiscal.issqnTaxation) +
    element(
      'tpRetISSQN',
      input.issWithheld ? ISS_RETENTION.WITHHELD_BY_TAKER : ISS_RETENTION.NOT_WITHHELD,
    ) +
    // Prestador não optante do Simples não informa alíquota: ela vem da
    // parametrização do município no Sistema Nacional (E0617).
    (input.issRate && input.fiscal.simplesNacional !== SIMPLES_NAO_OPTANTE
      ? element('pAliq', input.issRate)
      : '') +
    `</tribMun>` +
    `<totTrib>` +
    // Não optante do Simples não pode usar `indTotTrib` (E0713); informa os
    // percentuais aproximados (Lei 12.741). Zeros declaram que não há estimativa
    // a informar — valor a validar com a área fiscal antes de produção.
    (input.fiscal.simplesNacional === SIMPLES_NAO_OPTANTE
      ? `<pTotTrib>${element('pTotTribFed', input.totalTaxPercents?.federal ?? '0.00')}${element('pTotTribEst', input.totalTaxPercents?.state ?? '0.00')}${element('pTotTribMun', input.totalTaxPercents?.municipal ?? '0.00')}</pTotTrib>`
      : element('indTotTrib', TOTAL_TAX_INDICATOR_NONE)) +
    `</totTrib>` +
    `</trib>` +
    `</valores>`;

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<DPS xmlns="${NAMESPACE}" versao="${LAYOUT_VERSION}">` +
    `<infDPS Id="${idAttribute}">` +
    element('tpAmb', input.environment) +
    element('dhEmi', formatDateTimeWithOffset(input.issuedAt)) +
    element('verAplic', escapeXml(input.applicationVersion)) +
    element('serie', digitsOnly(input.series)) +
    element('nDPS', String(input.number)) +
    element('dCompet', formatDate(input.competency)) +
    element('tpEmit', ISSUER_TYPE_PROVIDER) +
    element('cLocEmi', String(input.issuerCityCode)) +
    provider +
    taker +
    service +
    values +
    `</infDPS>` +
    `</DPS>`;

  return { xml, dpsId, idAttribute };
}
