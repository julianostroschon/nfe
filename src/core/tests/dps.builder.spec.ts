import { BadRequestException } from '@nestjs/common';
import {
  buildDps,
  buildDpsId,
  DPS_ENVIRONMENT,
  type DpsFiscalClassification,
  type DpsInput,
} from '../dps.builder';
import { isXmlLintAvailable, validateAgainstXsd } from '../xsd-validator';

const PORTO_ALEGRE = 4314902;
const PROVIDER_CNPJ = '12345678000195';
const TAKER_CNPJ = '98765432000198';

/** Classificação fiscal sintética para validar o leiaute. */
const SERVICE_CLASSIFICATION: DpsFiscalClassification = {
  nationalServiceCode: '040205',
  simplesNacional: '1',
  specialTaxRegime: '0',
  issqnTaxation: '1',
};

function baseInput(overrides: Partial<DpsInput> = {}): DpsInput {
  return {
    environment: DPS_ENVIRONMENT.HOMOLOGATION,
    issuedAt: new Date('2026-08-17T14:30:00Z'),
    applicationVersion: 'FiscalService 0.1',
    series: '1',
    number: 1,
    competency: new Date('2026-08-01T00:00:00Z'),
    issuerCityCode: PORTO_ALEGRE,
    serviceCityCode: PORTO_ALEGRE,
    provider: {
      cnpj: PROVIDER_CNPJ,
      municipalRegistration: '123456',
      name: 'Empresa Sintética Teste LTDA',
    },
    taker: { cnpj: TAKER_CNPJ, name: 'Operadora Exemplo LTDA' },
    serviceDescription: 'Serviços técnicos genéricos',
    amount: '1500.00',
    issRate: '5.00',
    issWithheld: false,
    fiscal: SERVICE_CLASSIFICATION,
    ...overrides,
  };
}

describe('buildDpsId', () => {
  it('compõe os 42 dígitos na ordem do leiaute', () => {
    const id = buildDpsId({
      issuerCityCode: PORTO_ALEGRE,
      cnpj: PROVIDER_CNPJ,
      series: '1',
      number: 7,
    });

    expect(id).toHaveLength(42);
    // município (7) + tipo de inscrição (1, "2" para CNPJ) + CNPJ (14)
    expect(id.slice(0, 7)).toBe('4314902');
    expect(id.slice(7, 8)).toBe('2');
    expect(id.slice(8, 22)).toBe(PROVIDER_CNPJ);
    // série (5) e número (15), com zero à esquerda
    expect(id.slice(22, 27)).toBe('00001');
    expect(id.slice(27)).toBe('000000000000007');
  });

  it('aceita CNPJ com máscara, porque o cadastro pode trazer formatado', () => {
    const id = buildDpsId({
      issuerCityCode: PORTO_ALEGRE,
      cnpj: '12.345.678/0001-95',
      series: '1',
      number: 1,
    });

    expect(id.slice(8, 22)).toBe(PROVIDER_CNPJ);
  });
});

describe('buildDps', () => {
  it('prefixa o atributo Id com o literal DPS, totalizando 45 caracteres', () => {
    const { xml, dpsId, idAttribute } = buildDps(baseInput());

    expect(idAttribute).toBe(`DPS${dpsId}`);
    expect(idAttribute).toHaveLength(45);
    expect(xml).toContain(`<infDPS Id="${idAttribute}">`);
  });

  it('declara o namespace e a versão do layout vigente', () => {
    const { xml } = buildDps(baseInput());

    expect(xml).toContain('<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">');
  });

  it('emite dhEmi com deslocamento explícito, porque o layout não aceita Z', () => {
    const { xml } = buildDps(baseInput());

    expect(xml).toMatch(/<dhEmi>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-03:00<\/dhEmi>/);
    expect(xml).not.toContain('Z</dhEmi>');
  });

  it('declara a discriminação genérica, não a lista de serviços', () => {
    const { xml } = buildDps(baseInput());

    expect(xml).toContain('<xDescServ>Serviços técnicos genéricos</xDescServ>');
  });

  it('usa o código nacional de 6 dígitos, não o código LC 116', () => {
    const { xml } = buildDps(baseInput());

    expect(xml).toContain('<cTribNac>040205</cTribNac>');
    expect(xml).not.toContain('4.02');
  });

  it('marca retenção pelo tomador quando o ISS é retido', () => {
    const withheld = buildDps(baseInput({ issWithheld: true }));
    const notWithheld = buildDps(baseInput({ issWithheld: false }));

    expect(withheld.xml).toContain('<tpRetISSQN>2</tpRetISSQN>');
    expect(notWithheld.xml).toContain('<tpRetISSQN>1</tpRetISSQN>');
  });

  it('omite o grupo do tomador quando não há tomador, que o layout permite', () => {
    const { xml } = buildDps(baseInput({ taker: null }));

    expect(xml).not.toContain('<toma>');
    expect(xml).toContain('<prest>');
  });

  it('não envia o nome do prestador, porque o emitente é o próprio prestador (E0121)', () => {
    const { xml } = buildDps(baseInput());
    const prestador = xml.slice(xml.indexOf('<prest>'), xml.indexOf('</prest>'));

    expect(prestador).toContain('<IM>123456</IM>');
    expect(prestador).not.toContain('<xNome>');
    // O nome do tomador continua obrigatório no grupo dele.
    expect(xml).toContain('<xNome>Operadora Exemplo LTDA</xNome>');
  });

  it('não informa a alíquota quando o prestador não é optante do Simples (E0617)', () => {
    const { xml } = buildDps(baseInput({ issRate: '2.00' }));

    expect(xml).not.toContain('<pAliq>');
  });

  it('usa pTotTrib no lugar de indTotTrib para prestador não optante (E0713)', () => {
    const { xml } = buildDps(baseInput());

    expect(xml).toContain(
      '<totTrib><pTotTrib><pTotTribFed>0.00</pTotTribFed><pTotTribEst>0.00</pTotTribEst><pTotTribMun>0.00</pTotTribMun></pTotTrib></totTrib>',
    );
    expect(xml).not.toContain('<indTotTrib>');
  });

  it('mantém indTotTrib para prestador optante do Simples', () => {
    const { xml } = buildDps(
      baseInput({
        fiscal: { ...SERVICE_CLASSIFICATION, simplesNacional: '3', simplesNacionalRegime: '1' },
      }),
    );

    expect(xml).toContain('<indTotTrib>0</indTotTrib>');
  });

  it('informa a alíquota quando o prestador é optante do Simples', () => {
    const { xml } = buildDps(
      baseInput({
        issRate: '2.00',
        fiscal: { ...SERVICE_CLASSIFICATION, simplesNacional: '3', simplesNacionalRegime: '1' },
      }),
    );

    expect(xml).toContain('<pAliq>2.00</pAliq>');
  });

  it('escapa caracteres especiais da discriminação', () => {
    const { xml } = buildDps(baseInput({ serviceDescription: 'Serviço & descrição <empresa>' }));

    expect(xml).toContain('<xDescServ>Serviço &amp; descrição &lt;empresa&gt;</xDescServ>');
  });

  describe('formatos impostos pelo layout', () => {
    it('recusa código nacional que não tenha 6 dígitos', () => {
      expect(() =>
        buildDps(
          baseInput({
            fiscal: { ...SERVICE_CLASSIFICATION, nationalServiceCode: '4.02' },
          }),
        ),
      ).toThrow(BadRequestException);
    });

    it('recusa valor com zero à esquerda, que o tipo do layout rejeita', () => {
      expect(() => buildDps(baseInput({ amount: '0150.00' }))).toThrow(/fora do formato/i);
    });

    it('recusa alíquota de dois dígitos, que não cabe no tipo do layout', () => {
      expect(() => buildDps(baseInput({ issRate: '10.00' }))).toThrow(/um dígito e duas casas/i);
    });
  });

  /**
   * O valor destes testes é serem a única verificação de leiaute possível sem
   * acesso ao ambiente do fisco. Sem `xmllint`, são pulados com aviso — o que
   * aparece como "skipped" na suíte, e não como aprovação.
   */
  describe('validação contra o XSD oficial v1.01', () => {
    const available = isXmlLintAvailable();
    const itWithXsd = available ? it : it.skip;

    if (!available) {
      // biome-ignore lint/suspicious/noConsole: aviso é o ponto — pular calado seria pior
      console.warn(
        'xmllint ausente: validação de XSD pulada. Instale libxml2-utils para exercitá-la.',
      );
    }

    itWithXsd('valida um DPS completo, com tomador', () => {
      const { xml } = buildDps(baseInput());
      const result = validateAgainstXsd(xml);

      expect(result.errors).toBe('');
      expect(result.valid).toBe(true);
    });

    itWithXsd('valida um DPS sem tomador', () => {
      const { xml } = buildDps(baseInput({ taker: null }));
      const result = validateAgainstXsd(xml);

      expect(result.errors).toBe('');
      expect(result.valid).toBe(true);
    });

    itWithXsd('valida com ISS retido e sem inscrição municipal', () => {
      const { xml } = buildDps(
        baseInput({
          issWithheld: true,
          provider: { cnpj: PROVIDER_CNPJ, municipalRegistration: null },
        }),
      );
      const result = validateAgainstXsd(xml);

      expect(result.errors).toBe('');
      expect(result.valid).toBe(true);
    });

    itWithXsd('valida optante do Simples com regime de apuração', () => {
      const { xml } = buildDps(
        baseInput({
          fiscal: {
            ...SERVICE_CLASSIFICATION,
            simplesNacional: '3',
            simplesNacionalRegime: '1',
          },
        }),
      );
      const result = validateAgainstXsd(xml);

      expect(result.errors).toBe('');
      expect(result.valid).toBe(true);
    });

    /**
     * Guarda contra falso positivo: se o validador aceitasse qualquer coisa, os
     * testes acima não provariam nada.
     */
    itWithXsd('reprova um documento fora do esquema', () => {
      const result = validateAgainstXsd(
        '<?xml version="1.0"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><naoExiste/></DPS>',
      );

      expect(result.valid).toBe(false);
      expect(result.errors).not.toBe('');
    });

    /**
     * O esquema oficial v1.01 tem um defeito em `TSSerieDPS`, que a validação
     * ignora explicitamente. Este teste existe para que a exceção não sobreviva à
     * correção: quando o fisco publicar esquema corrigido, ele falha e a entrada
     * sai da lista de defeitos conhecidos.
     */
    itWithXsd('o defeito conhecido do facet de série continua presente', () => {
      const { xml } = buildDps(baseInput());
      const result = validateAgainstXsd(xml);

      expect(result.errors).toBe('');
      expect(result.rawErrors).toContain("}serie'");
      expect(result.rawErrors).toContain("[facet 'pattern']");
    });
  });
});
