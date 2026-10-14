import { BadRequestException } from '@nestjs/common';
import { readPkcs12 } from '../pkcs12.reader';
import { createTestPkcs12 } from './pkcs12.fixture';

const PASSWORD = 'senha-do-certificado';

describe('readPkcs12', () => {
  // Geração de RSA em JS puro é lenta; um arquivo serve a vários casos.
  let validFile: Buffer;

  beforeAll(() => {
    validFile = createTestPkcs12({ password: PASSWORD });
  });

  describe('Cenário 1 — cadastrar certificado válido', () => {
    it('extrai titular, CNPJ e validade do próprio certificado', () => {
      const data = readPkcs12(validFile, PASSWORD);

      expect(data.subjectName).toBe('empresa IMAGEM TESTE LTDA:12345678000199');
      expect(data.cnpj).toBe('12345678000199');
      expect(data.validFrom).toEqual(new Date('2026-01-01T00:00:00Z'));
      expect(data.validUntil).toEqual(new Date('2027-01-01T00:00:00Z'));
    });

    it('calcula uma impressão digital SHA-256 estável para o mesmo arquivo', () => {
      const first = readPkcs12(validFile, PASSWORD);
      const second = readPkcs12(validFile, PASSWORD);

      expect(first.fingerprint).toMatch(/^[0-9A-F]{64}$/);
      expect(second.fingerprint).toBe(first.fingerprint);
    });

    it('lê o CNPJ do CN quando o certificado não traz a extensão ICP-Brasil', () => {
      const file = createTestPkcs12({
        password: PASSWORD,
        includeCnpjExtension: false,
      });

      expect(readPkcs12(file, PASSWORD).cnpj).toBe('12345678000199');
    });

    it('devolve CNPJ nulo quando o certificado não o declara em lugar nenhum', () => {
      const file = createTestPkcs12({
        password: PASSWORD,
        includeCnpjExtension: false,
        includeCnpjInCommonName: false,
      });

      const data = readPkcs12(file, PASSWORD);

      expect(data.cnpj).toBeNull();
      expect(data.subjectName).toBe('empresa IMAGEM TESTE LTDA');
    });
  });

  describe('Cenário 2 — senha errada é recusada na hora', () => {
    it('recusa a leitura quando a senha não abre o arquivo', () => {
      expect(() => readPkcs12(validFile, 'senha-errada')).toThrow(BadRequestException);
      expect(() => readPkcs12(validFile, 'senha-errada')).toThrow(/a senha não confere/i);
    });

    it('recusa arquivo que não é PKCS#12 com a mesma mensagem, sem afirmar a causa errada', () => {
      const notACertificate = Buffer.from('isto nao e um pfx', 'utf8');

      expect(() => readPkcs12(notACertificate, PASSWORD)).toThrow(
        /a senha não confere ou o arquivo não é um .pfx/i,
      );
    });

    it('não repete conteúdo do arquivo nem a senha na mensagem de erro', () => {
      try {
        readPkcs12(validFile, PASSWORD.toUpperCase());
        throw new Error('deveria ter recusado');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain(PASSWORD.toUpperCase());
        expect(message).not.toContain(validFile.toString('latin1').slice(0, 16));
      }
    });
  });
});
