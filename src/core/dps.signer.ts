import { BadRequestException, Logger } from '@nestjs/common';
// Import de namespace: o projeto não liga `esModuleInterop`.
import * as forge from 'node-forge';
import { SignedXml } from 'xml-crypto';

/**
 * Assinatura XMLDSIG dos documentos do padrão nacional com o certificado A1 da
 * empresa: a DPS da emissão e o pedido de registro de evento do cancelamento.
 *
 * A assinatura é **enveloped** nos dois: o elemento `Signature` entra dentro da
 * raiz, como irmão do bloco de informações, e referencia esse bloco pelo
 * atributo `Id`. É o que o padrão nacional espera; os erros 2104 (assinatura
 * ausente) e 2105 (assinatura inválida) do fisco vêm de errar exatamente isso.
 *
 * Usa `xml-crypto` em vez de assinar à mão porque XMLDSIG exige canonicalização
 * C14N do trecho assinado. Canonicalizar à mão é a parte mais fácil de errar e a
 * mais difícil de diagnosticar, porque a rejeição do fisco não diz onde.
 *
 * Nada aqui vai para log: nem a senha, nem o conteúdo do `.pfx`, nem a chave
 * privada em PEM. Quem tem esse par assina documento fiscal em nome da empresa.
 */

/** Algoritmos exigidos pelo padrão: RSA-SHA1 com C14N inclusiva. */
const SIGNATURE_ALGORITHM = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const DIGEST_ALGORITHM = 'http://www.w3.org/2000/09/xmldsig#sha1';
const CANONICALIZATION = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED_SIGNATURE = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

export interface SigningMaterialPem {
  /** Chave privada em PEM, só em memória. */
  privateKeyPem: string;
  /** Certificado do titular em PEM, sem cabeçalho, para o `X509Certificate`. */
  certificatePem: string;
}

/**
 * Extrai chave e certificado do `.pfx` para o formato que o assinador consome.
 *
 * Separado da assinatura para deixar explícito que o material decifrado existe
 * apenas dentro desta operação. O `.pfx` é PKCS#12: a chave privada vem do
 * `pkcs8ShroudedKeyBag`, e o certificado do titular é o que está pareado com ela
 * pelo `localKeyId` — não necessariamente o primeiro da cadeia.
 */
export function extractSigningMaterial(pfx: Buffer, password: string): SigningMaterialPem {
  let p12: forge.pkcs12.Pkcs12Pfx;

  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('latin1')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  } catch {
    // Sem detalhe da biblioteca: ela repete trechos do arquivo na mensagem.
    throw new BadRequestException(
      'Não foi possível abrir o certificado para assinar: a senha não confere ou o arquivo está corrompido',
    );
  }

  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];

  const keyBag = keyBags.find((bag) => bag.key);
  if (!keyBag?.key) {
    throw new BadRequestException(
      'O certificado não contém chave privada; assinar exige um certificado A1 completo',
    );
  }

  const keyLocalId = keyBag.attributes?.localKeyId?.[0];

  type CertificateBag = forge.pkcs12.Bag & { cert?: forge.pki.Certificate };
  const certBags = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ??
    []) as CertificateBag[];

  const paired = keyLocalId
    ? certBags.find((bag) => bag.attributes?.localKeyId?.[0] === keyLocalId)
    : undefined;

  const holder =
    paired ??
    certBags.find((bag) => {
      const constraints = bag.cert?.getExtension('basicConstraints') as
        | { cA?: boolean }
        | undefined;
      return bag.cert && constraints?.cA !== true;
    }) ??
    certBags[0];

  if (!holder?.cert) {
    throw new BadRequestException('O certificado não contém o certificado do titular');
  }

  return {
    privateKeyPem: forge.pki.privateKeyToPem(keyBag.key as forge.pki.rsa.PrivateKey),
    certificatePem: forge.pki.certificateToPem(holder.cert),
  };
}

/** Só o base64 do DER, que é o conteúdo de `X509Certificate` no KeyInfo. */
function certificateToBase64(certificatePem: string): string {
  return certificatePem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
}

/**
 * Assina um documento do padrão nacional. Devolve o XML com o `Signature`
 * inserido dentro da raiz.
 *
 * O `Id` do bloco de informações é o alvo da referência (`URI="#..."`), e as
 * transformas são enveloped-signature seguida de C14N — nessa ordem, que é a que
 * o verificador do fisco espera.
 */
function signEnveloped(params: {
  xml: string;
  /** Elemento raiz, onde o `Signature` é anexado (`DPS`, `pedRegEvento`). */
  rootElement: string;
  /** Elemento assinado, localizado pelo `Id` (`infDPS`, `infPedReg`). */
  signedElement: string;
  /** Valor do atributo `Id` do elemento assinado, com o prefixo. */
  idAttribute: string;
  material: SigningMaterialPem;
  /** Nome do documento na mensagem de erro, em português. */
  documentLabel: string;
}): string {
  const { xml, rootElement, signedElement, idAttribute, material, documentLabel } = params;

  const signer = new SignedXml({
    privateKey: material.privateKeyPem,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    canonicalizationAlgorithm: CANONICALIZATION,
  });

  signer.addReference({
    // Assina o bloco de informações inteiro, localizado pelo Id.
    xpath: `//*[local-name(.)='${signedElement}']`,
    transforms: [ENVELOPED_SIGNATURE, CANONICALIZATION],
    digestAlgorithm: DIGEST_ALGORITHM,
    uri: idAttribute,
  });

  // O fisco precisa do certificado para verificar a assinatura; sem KeyInfo a
  // rejeição vem como assinatura inválida.
  signer.getKeyInfoContent = () =>
    `<X509Data><X509Certificate>${certificateToBase64(material.certificatePem)}</X509Certificate></X509Data>`;

  try {
    signer.computeSignature(xml, {
      // A assinatura entra como último filho da raiz, depois do bloco de
      // informações, que é a posição que a sequência do esquema define.
      location: {
        reference: `//*[local-name(.)='${rootElement}']`,
        action: 'append',
      },
    });
  } catch (error) {
    // A mensagem da biblioteca pode carregar trecho do documento, mas nunca a
    // chave; ainda assim, não propagamos o detalhe adiante.
    new Logger('DpsSigner').error(
      `Falha ao assinar ${documentLabel} ${idAttribute}: ${(error as Error).name}`,
    );
    throw new BadRequestException(
      `Não foi possível assinar ${documentLabel} com o certificado cadastrado`,
    );
  }

  return signer.getSignedXml();
}

/** Assina a DPS: `Signature` dentro de `DPS`, referenciando `infDPS`. */
export function signDps(params: {
  xml: string;
  /** Valor do atributo `Id` do `infDPS`, com o prefixo `DPS`. */
  idAttribute: string;
  material: SigningMaterialPem;
}): string {
  return signEnveloped({
    xml: params.xml,
    rootElement: 'DPS',
    signedElement: 'infDPS',
    idAttribute: params.idAttribute,
    material: params.material,
    documentLabel: 'a declaração fiscal',
  });
}

/**
 * Assina o pedido de registro de evento do cancelamento: `Signature` dentro de
 * `pedRegEvento`, referenciando `infPedReg`.
 *
 * O esquema declara a assinatura como opcional (`minOccurs="0"`), mas o serviço
 * recusa o pedido sem ela — cancelar é ato que precisa provar quem pediu, tanto
 * quanto emitir.
 */
export function signCancellationEvent(params: {
  xml: string;
  /** Valor do atributo `Id` do `infPedReg`, com o prefixo `PRE`. */
  idAttribute: string;
  material: SigningMaterialPem;
}): string {
  return signEnveloped({
    xml: params.xml,
    rootElement: 'pedRegEvento',
    signedElement: 'infPedReg',
    idAttribute: params.idAttribute,
    material: params.material,
    documentLabel: 'o pedido de cancelamento',
  });
}
