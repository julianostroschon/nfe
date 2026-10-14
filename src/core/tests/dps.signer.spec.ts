import { BadRequestException } from '@nestjs/common';
import { createTestPkcs12 } from '../../certificates/tests/pkcs12.fixture';
import { SignedXml } from 'xml-crypto';
import { buildDps, DPS_ENVIRONMENT, type DpsFiscalClassification } from '../dps.builder';
import { extractSigningMaterial, signDps } from '../dps.signer';
import { isXmlLintAvailable, validateAgainstXsd } from '../xsd-validator';

const PASSWORD = 'teste123';
const PROVIDER_CNPJ = '12345678000195';
const PORTO_ALEGRE = 4314902;

const SERVICE_A: DpsFiscalClassification = {
  nationalServiceCode: '040205',
  simplesNacional: '1',
  specialTaxRegime: '0',
  issqnTaxation: '1',
};

function buildSampleDps() {
  return buildDps({
    environment: DPS_ENVIRONMENT.HOMOLOGATION,
    issuedAt: new Date('2026-08-17T14:30:00Z'),
    applicationVersion: 'FiscalService 0.1',
    series: '1',
    number: 1,
    competency: new Date('2026-08-01T00:00:00Z'),
    issuerCityCode: PORTO_ALEGRE,
    serviceCityCode: PORTO_ALEGRE,
    provider: { cnpj: PROVIDER_CNPJ, name: 'Empresa Sintética Teste LTDA' },
    taker: { cnpj: '98765432000198', name: 'Operadora Exemplo LTDA' },
    serviceDescription: 'Serviços técnicos genéricos',
    amount: '1500.00',
    issRate: '5.00',
    issWithheld: false,
    fiscal: SERVICE_A,
  });
}

describe('assinatura da DPS', () => {
  let pfx: Buffer;

  beforeAll(() => {
    pfx = createTestPkcs12({ password: PASSWORD, cnpj: PROVIDER_CNPJ });
  });

  describe('extractSigningMaterial', () => {
    it('extrai chave privada e certificado do titular do .pfx', () => {
      const material = extractSigningMaterial(pfx, PASSWORD);

      expect(material.privateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
      expect(material.certificatePem).toContain('BEGIN CERTIFICATE');
    });

    it('recusa senha errada sem repetir a senha na mensagem', () => {
      expect(() => extractSigningMaterial(pfx, 'errada')).toThrow(BadRequestException);

      try {
        extractSigningMaterial(pfx, 'senha-secreta-xyz');
      } catch (error) {
        expect((error as Error).message).not.toContain('senha-secreta-xyz');
      }
    });
  });

  describe('signDps', () => {
    it('insere a assinatura dentro do DPS, como irmã de infDPS', () => {
      const { xml, idAttribute } = buildSampleDps();
      const signed = signDps({
        xml,
        idAttribute,
        material: extractSigningMaterial(pfx, PASSWORD),
      });

      expect(signed).toContain('<Signature');
      // A assinatura fecha o DPS: vem depois de infDPS, não dentro dele.
      expect(signed.indexOf('</infDPS>')).toBeLessThan(signed.indexOf('<Signature'));
      expect(signed.trim().endsWith('</DPS>')).toBe(true);
    });

    it('referencia o infDPS pelo Id, que é o que o fisco verifica', () => {
      const { xml, idAttribute } = buildSampleDps();
      const signed = signDps({
        xml,
        idAttribute,
        material: extractSigningMaterial(pfx, PASSWORD),
      });

      // A referência é um fragmento, então leva `#` antes do Id.
      expect(signed).toContain(`URI="#${idAttribute}"`);
    });

    it('inclui o certificado no KeyInfo, sem o qual a assinatura é recusada', () => {
      const { xml, idAttribute } = buildSampleDps();
      const material = extractSigningMaterial(pfx, PASSWORD);
      const signed = signDps({ xml, idAttribute, material });

      expect(signed).toContain('<X509Certificate>');
      const base64 = material.certificatePem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
      expect(signed).toContain(base64);
    });

    /**
     * O teste que importa: a assinatura produzida é verificável com a chave
     * pública do próprio certificado. Sem isto, os demais só provariam que
     * existe um elemento `Signature` — não que ele assina de verdade.
     */
    it('produz assinatura que verifica contra o certificado', () => {
      const { xml, idAttribute } = buildSampleDps();
      const material = extractSigningMaterial(pfx, PASSWORD);
      const signed = signDps({ xml, idAttribute, material });

      const signatureXml = /<Signature[\s\S]*<\/Signature>/.exec(signed)?.[0];
      expect(signatureXml).toBeDefined();

      const verifier = new SignedXml({ publicCert: material.certificatePem });
      verifier.loadSignature(signatureXml as string);

      expect(verifier.checkSignature(signed)).toBe(true);
    });

    it('detecta adulteração do documento assinado', () => {
      const { xml, idAttribute } = buildSampleDps();
      const material = extractSigningMaterial(pfx, PASSWORD);
      const signed = signDps({ xml, idAttribute, material });

      // Trocar o valor do serviço depois de assinar tem de invalidar a assinatura.
      const tampered = signed.replace('<vServ>1500.00</vServ>', '<vServ>15.00</vServ>');

      const signatureXml = /<Signature[\s\S]*<\/Signature>/.exec(tampered)?.[0];
      const verifier = new SignedXml({ publicCert: material.certificatePem });
      verifier.loadSignature(signatureXml as string);

      expect(verifier.checkSignature(tampered)).toBe(false);
    });

    const itWithXsd = isXmlLintAvailable() ? it : it.skip;

    itWithXsd('o documento assinado continua válido no esquema oficial', () => {
      const { xml, idAttribute } = buildSampleDps();
      const signed = signDps({
        xml,
        idAttribute,
        material: extractSigningMaterial(pfx, PASSWORD),
      });

      const result = validateAgainstXsd(signed);

      expect(result.errors).toBe('');
      expect(result.valid).toBe(true);
    });
  });
});
