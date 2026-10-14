import { BadRequestException } from '@nestjs/common';
import {
  buildCancellationEvent,
  buildCancellationEventId,
  CANCELLATION_REASON_CODE,
  EVENT_ENVIRONMENT,
  normalizeCancellationReason,
} from '../cancellation-event.builder';
import { isXmlLintAvailable, PED_REG_EVENTO_SCHEMA, validateAgainstXsd } from '../xsd-validator';

/** Chave de acesso plausível: 50 dígitos, como o fisco devolve. */
const ACCESS_KEY = '4'.repeat(50);
const AUTHOR_CNPJ = '12345678000199';
const REASON = 'Nota emitida para o tomador errado no fechamento do lote';

function baseInput() {
  return {
    environment: EVENT_ENVIRONMENT.HOMOLOGATION,
    requestedAt: new Date('2026-09-14T12:30:00.000Z'),
    applicationVersion: 'FiscalService',
    authorCnpj: AUTHOR_CNPJ,
    accessKey: ACCESS_KEY,
    reasonCode: CANCELLATION_REASON_CODE.ISSUE_ERROR,
    reason: REASON,
  };
}

describe('cancellation-event.builder', () => {
  describe('buildCancellationEventId', () => {
    it('compõe PRE mais a chave de acesso e o código do evento, 56 dígitos', () => {
      const id = buildCancellationEventId(ACCESS_KEY);

      expect(id).toBe(`PRE${ACCESS_KEY}101101`);
      expect(id).toMatch(/^PRE[0-9]{56}$/);
    });

    it('recusa chave que não tem os 50 dígitos', () => {
      expect(() => buildCancellationEventId('123')).toThrow(/esperados 56/);
    });
  });

  describe('buildCancellationEvent', () => {
    it('declara o motivo em código e texto, na ordem do esquema', () => {
      const { xml } = buildCancellationEvent(baseInput());

      expect(xml).toContain('<xDesc>Cancelamento de NFS-e</xDesc>');
      expect(xml).toContain('<cMotivo>1</cMotivo>');
      expect(xml).toContain(`<xMotivo>${REASON}</xMotivo>`);
      expect(xml).toContain(`<chNFSe>${ACCESS_KEY}</chNFSe>`);
      expect(xml).toContain(`<CNPJAutor>${AUTHOR_CNPJ}</CNPJAutor>`);

      // A ordem dos elementos é normativa em XML Schema.
      expect(xml.indexOf('<tpAmb>')).toBeLessThan(xml.indexOf('<verAplic>'));
      expect(xml.indexOf('<verAplic>')).toBeLessThan(xml.indexOf('<dhEvento>'));
      expect(xml.indexOf('<dhEvento>')).toBeLessThan(xml.indexOf('<CNPJAutor>'));
      expect(xml.indexOf('<CNPJAutor>')).toBeLessThan(xml.indexOf('<chNFSe>'));
      expect(xml.indexOf('<chNFSe>')).toBeLessThan(xml.indexOf('<e101101>'));
    });

    it('usa deslocamento explícito de fuso em dhEvento, sem Z', () => {
      const { xml } = buildCancellationEvent(baseInput());

      expect(xml).toMatch(/<dhEvento>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-03:00<\/dhEvento>/);
      expect(xml).not.toContain('Z</dhEvento>');
    });

    it('escapa o motivo, que é texto livre de quem cancela', () => {
      const { xml } = buildCancellationEvent({
        ...baseInput(),
        reason: 'tomador A & B emitiu <errado> no lote de setembro',
      });

      expect(xml).toContain(
        '<xMotivo>tomador A &amp; B emitiu &lt;errado&gt; no lote de setembro</xMotivo>',
      );
    });

    it('recusa motivo curto demais para o layout, antes de transmitir', () => {
      expect(() => buildCancellationEvent({ ...baseInput(), reason: 'erro' })).toThrow(
        BadRequestException,
      );
    });

    it('recusa motivo acima do limite do layout', () => {
      expect(() => buildCancellationEvent({ ...baseInput(), reason: 'a'.repeat(256) })).toThrow(
        BadRequestException,
      );
    });

    it('recusa chave de acesso fora do formato do padrão nacional', () => {
      expect(() => buildCancellationEvent({ ...baseInput(), accessKey: '123' })).toThrow(
        BadRequestException,
      );
    });

    it('recusa CNPJ do autor fora do formato', () => {
      expect(() => buildCancellationEvent({ ...baseInput(), authorCnpj: '123' })).toThrow(
        BadRequestException,
      );
    });
  });

  describe('normalização do motivo para o alfabeto do leiaute', () => {
    it('troca quebra de linha e tabulação por espaço', () => {
      expect(normalizeCancellationReason('Emitida errada\nconferir com o tomador')).toBe(
        'Emitida errada conferir com o tomador',
      );
      expect(normalizeCancellationReason('a\tb')).toBe('a b');
    });

    it('troca a pontuação tipográfica que teclado e editor produzem sozinhos', () => {
      expect(normalizeCancellationReason('Emitida errada — “tomador” trocado…')).toBe(
        'Emitida errada - "tomador" trocado...',
      );
    });

    it('preserva a acentuação, que está dentro da faixa do leiaute', () => {
      expect(normalizeCancellationReason('Emissão à operadora errada')).toBe(
        'Emissão à operadora errada',
      );
    });

    it('remove o que não tem substituto honesto, em vez de adivinhar', () => {
      expect(normalizeCancellationReason('Nota emitida 🙂 errada')).toBe('Nota emitida errada');
    });

    /**
     * O mínimo do leiaute vale sobre o texto que sai no documento. Medir antes
     * de normalizar deixaria passar uma justificativa que encolhe abaixo do
     * mínimo justamente ao perder os caracteres que o fisco não aceita.
     */
    it('recusa motivo que só alcança o mínimo antes da normalização', () => {
      expect(() =>
        buildCancellationEvent({
          ...baseInput(),
          reason: 'erro🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂',
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('conformidade com o esquema oficial', () => {
    // Pulado com aviso onde o binário não existe: quebrar o CI por ausência de
    // ferramenta de sistema não ajuda, e passar em silêncio seria pior.
    const maybe = isXmlLintAvailable() ? it : it.skip;

    if (!isXmlLintAvailable()) {
      // biome-ignore lint/suspicious/noConsole: o aviso é o ponto do skip
      console.warn(
        'xmllint não encontrado: validação do pedido de evento contra o XSD oficial foi pulada',
      );
    }

    maybe('o pedido de cancelamento valida contra pedRegEvento_v1.01.xsd', () => {
      const { xml } = buildCancellationEvent(baseInput());

      const result = validateAgainstXsd(xml, PED_REG_EVENTO_SCHEMA);

      expect(result.errors).toBe('');
      expect(result.valid).toBe(true);
    });

    /**
     * Regressão do achado da revisão: `xMotivo` é `TSString`, cujo padrão só
     * admite de `!` (U+0021) a `ÿ` (U+00FF), com espaço no miolo. Antes da
     * normalização, um Enter no campo de motivo gerava documento recusado por
     * leiaute — e a recusa entrava no histórico como se o fisco tivesse
     * avaliado o cancelamento.
     */
    maybe('valida com motivo que o usuário digita com quebra de linha', () => {
      const { xml } = buildCancellationEvent({
        ...baseInput(),
        reason: 'Emitida para o tomador errado\nconferir no fechamento do lote',
      });

      const result = validateAgainstXsd(xml, PED_REG_EVENTO_SCHEMA);

      expect(result.errors).toBe('');
    });

    maybe('valida com motivo colado com travessão e aspas curvas', () => {
      const { xml } = buildCancellationEvent({
        ...baseInput(),
        reason: 'Emitida errada — “tomador” trocado no fechamento do lote',
      });

      const result = validateAgainstXsd(xml, PED_REG_EVENTO_SCHEMA);

      expect(result.errors).toBe('');
    });

    maybe('valida com motivo acentuado', () => {
      const { xml } = buildCancellationEvent({
        ...baseInput(),
        reason: 'Emissão à operadora errada na conferência do lote',
      });

      const result = validateAgainstXsd(xml, PED_REG_EVENTO_SCHEMA);

      expect(result.errors).toBe('');
    });

    maybe('valida com os três códigos de justificativa aceitos', () => {
      for (const reasonCode of Object.values(CANCELLATION_REASON_CODE)) {
        const { xml } = buildCancellationEvent({ ...baseInput(), reasonCode });

        const result = validateAgainstXsd(xml, PED_REG_EVENTO_SCHEMA);

        expect(result.errors).toBe('');
      }
    });
  });
});
