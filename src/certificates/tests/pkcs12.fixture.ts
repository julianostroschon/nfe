import * as forge from 'node-forge';

/**
 * Gera um `.pfx` sintético para os testes.
 *
 * Um certificado A1 real não pode entrar no repositório — é credencial —, então
 * os testes constroem o arquivo em memória com a mesma estrutura que precisam
 * exercitar: cadeia PKCS#12 protegida por senha, CN no formato do e-CNPJ e o
 * CNPJ no `subjectAltName` sob o OID ICP-Brasil.
 *
 * A chave é de 1024 bits porque a geração de RSA em JS puro é lenta e aqui o
 * tamanho não muda nada do que está sendo testado. Certificado de verdade usa
 * 2048 — este arquivo nunca sai dos testes.
 */

/** OID ICP-Brasil 2.16.76.1.3.3 (CNPJ da pessoa jurídica), em bytes DER. */
const CNPJ_OID_BYTES = '\x06\x05\x60\x4c\x01\x03\x03';

export interface Pkcs12FixtureOptions {
  password: string;
  /** Razão social que vai no CN, antes do CNPJ. */
  companyName?: string;
  cnpj?: string;
  validFrom?: Date;
  validUntil?: Date;
  /** Quando falso, o CNPJ sai só no CN — exercita o caminho de fallback. */
  includeCnpjExtension?: boolean;
  /** Quando falso, o CN não recebe o sufixo `:CNPJ`. */
  includeCnpjInCommonName?: boolean;
}

/**
 * Monta o `otherName` do CNPJ: o OID seguido do valor em `PrintableString`,
 * dentro do envelope `[0]` que a estrutura exige.
 */
function buildCnpjOtherName(cnpj: string): string {
  const value = `\x13${String.fromCharCode(cnpj.length)}${cnpj}`;
  const wrapper = `\xa0${String.fromCharCode(value.length)}${value}`;
  return `${CNPJ_OID_BYTES}${wrapper}`;
}

export function createTestPkcs12(options: Pkcs12FixtureOptions): Buffer {
  const {
    password,
    companyName = 'empresa IMAGEM TESTE LTDA',
    cnpj = '12345678000199',
    validFrom = new Date('2026-01-01T00:00:00Z'),
    validUntil = new Date('2027-01-01T00:00:00Z'),
    includeCnpjExtension = true,
    includeCnpjInCommonName = true,
  } = options;

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();

  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = validFrom;
  certificate.validity.notAfter = validUntil;

  const commonName = includeCnpjInCommonName ? `${companyName}:${cnpj}` : companyName;
  const subject = [{ name: 'commonName', value: commonName }];

  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: false },
    ...(includeCnpjExtension
      ? [
          {
            name: 'subjectAltName',
            altNames: [{ type: 0, value: buildCnpjOtherName(cnpj) }],
          },
        ]
      : []),
  ]);
  certificate.sign(keys.privateKey);

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [certificate], password);

  return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'latin1');
}
