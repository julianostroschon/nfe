import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
// Import de namespace: o projeto não liga `esModuleInterop`, então o default de
// um pacote CommonJS chegaria como `undefined` em tempo de execução.
import * as forge from 'node-forge';

/**
 * Leitura de certificado A1 em arquivo PKCS#12 (`.pfx` / `.p12`).
 *
 * Existe separado do service porque é a única parte que lida com o formato do
 * arquivo: abrir com a senha, achar o certificado do titular no meio da cadeia
 * e ler os campos que o cadastro exibe. Nada aqui persiste nem decide regra de
 * negócio — conferir CNPJ e validade é do service.
 *
 * O conteúdo do arquivo nunca entra em mensagem de erro: quem tem o `.pfx` e a
 * senha assina em nome da empresa.
 */

/** OID ICP-Brasil "CNPJ da pessoa jurídica", em DER: 2.16.76.1.3.3. */
const CNPJ_OID_DER = Buffer.from([0x06, 0x05, 0x60, 0x4c, 0x01, 0x03, 0x03]);

/** Janela de bytes após o OID onde o CNPJ aparece, já contando o envelope ASN.1. */
const CNPJ_LOOKAHEAD_BYTES = 40;

export interface Pkcs12CertificateData {
  /** Titular do certificado (CN do subject). */
  subjectName: string;
  /** CNPJ com 14 dígitos, quando o certificado o declara. */
  cnpj: string | null;
  validFrom: Date;
  validUntil: Date;
  /** SHA-256 do DER do certificado, em hexadecimal maiúsculo. */
  fingerprint: string;
}

type CertificateBag = forge.pkcs12.Bag & { cert?: forge.pki.Certificate };

/**
 * O `.pfx` traz a cadeia inteira: o certificado do titular mais as ACs que o
 * emitiram. Assinar exige o do titular, e é dele que saem titular, CNPJ e
 * validade — pegar o primeiro da lista daria a AC em muitos arquivos.
 *
 * A identificação certa é o `localKeyId`, o atributo que amarra certificado e
 * chave privada dentro do arquivo. Quando ele não está presente, sobra excluir
 * quem é autoridade certificadora (`basicConstraints` com `cA`).
 */
function findHolderCertificate(p12: forge.pkcs12.Pkcs12Pfx): forge.pki.Certificate {
  const certBags = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ??
    []) as CertificateBag[];

  const certificates = certBags
    .map((bag) => ({ bag, cert: bag.cert }))
    .filter((entry): entry is { bag: CertificateBag; cert: forge.pki.Certificate } => !!entry.cert);

  if (certificates.length === 0) {
    throw new BadRequestException(
      'O arquivo não contém certificado; verifique se é um certificado A1 em formato .pfx ou .p12',
    );
  }

  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];

  const keyLocalId = keyBags
    .map((bag) => bag.attributes?.localKeyId?.[0])
    .find((localKeyId) => !!localKeyId);

  if (keyLocalId) {
    const paired = certificates.find(
      (entry) => entry.bag.attributes?.localKeyId?.[0] === keyLocalId,
    );
    if (paired) {
      return paired.cert;
    }
  }

  const notAuthority = certificates.find((entry) => {
    const basicConstraints = entry.cert.getExtension('basicConstraints') as
      | { cA?: boolean }
      | undefined;
    return basicConstraints?.cA !== true;
  });

  return (notAuthority ?? certificates[0]).cert;
}

/**
 * O CNPJ vem do próprio certificado, não de digitação: no padrão ICP-Brasil ele
 * fica no `subjectAltName`, sob o OID 2.16.76.1.3.3, como 14 dígitos. A leitura
 * é feita sobre o DER porque o `otherName` desse OID não é um tipo que o parser
 * genérico de nomes alternativos devolva pronto.
 *
 * Sem o OID, resta o CN: o e-CNPJ o escreve como "RAZAO SOCIAL:12345678000199".
 */
function extractCnpj(certificateDer: Buffer, subjectName: string): string | null {
  const oidAt = certificateDer.indexOf(CNPJ_OID_DER);

  if (oidAt >= 0) {
    const start = oidAt + CNPJ_OID_DER.length;
    const window = certificateDer.subarray(start, start + CNPJ_LOOKAHEAD_BYTES).toString('latin1');
    const fromExtension = /\d{14}/.exec(window);
    if (fromExtension) {
      return fromExtension[0];
    }
  }

  const fromCommonName = /:(\d{14})\s*$/.exec(subjectName);
  return fromCommonName ? fromCommonName[1] : null;
}

/**
 * Abre o arquivo com a senha informada e devolve os dados do titular.
 *
 * Senha incorreta e arquivo corrompido chegam aqui como a mesma falha do
 * node-forge (a verificação do MAC), e é assim que devem ser tratados: o
 * sistema não tem como distinguir os dois, e a mensagem cita as duas causas em
 * vez de afirmar a errada.
 */
export function readPkcs12(file: Buffer, password: string): Pkcs12CertificateData {
  let p12: forge.pkcs12.Pkcs12Pfx;

  try {
    // O node-forge trabalha com string binária, não com Buffer do Node.
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(file.toString('latin1')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  } catch {
    // Sem detalhe da biblioteca na mensagem: ela repete trechos do arquivo.
    throw new BadRequestException(
      'Não foi possível abrir o certificado: a senha não confere ou o arquivo não é um .pfx/.p12 válido',
    );
  }

  const certificate = findHolderCertificate(p12);

  const certificateDer = Buffer.from(
    forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(),
    'latin1',
  );

  const commonName = certificate.subject.getField('CN')?.value;
  if (!commonName) {
    throw new BadRequestException(
      'O certificado não informa o titular (CN); verifique se o arquivo é um certificado e-CNPJ',
    );
  }

  const subjectName = String(commonName).trim();

  return {
    subjectName,
    cnpj: extractCnpj(certificateDer, subjectName),
    validFrom: certificate.validity.notBefore,
    validUntil: certificate.validity.notAfter,
    fingerprint: createHash('sha256').update(certificateDer).digest('hex').toUpperCase(),
  };
}
