import { gunzipSync, gzipSync } from 'node:zlib';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createTestPkcs12 } from '../../certificates/tests/pkcs12.fixture';
import {
  NFSE_ENVIRONMENT,
  NfseNationalClient,
  type NfseClientCredentials,
} from '../nfse-national.client';
import { type MtlsServerHandle, startMtlsServer } from './mtls-server.fixture';

const PASSWORD = 'teste123';
const ACCESS_KEY = '43149021234567800019500000000000000000000000000001';

/**
 * Aceita a string do ambiente (forma curta, usada pela maioria dos testes) ou o
 * mapa completo de variáveis, para os testes que precisam de mais de uma.
 */
function clientWith(config?: string | Record<string, string | undefined>): NfseNationalClient {
  const env =
    typeof config === 'string' || config === undefined ? { NFSE_ENVIRONMENT: config } : config;

  return new NfseNationalClient({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
}

describe('NfseNationalClient', () => {
  /**
   * O Nest injeta o `ConfigService` pelo tipo. Se o import virar `import type`,
   * o tipo some em runtime e a API não sobe, mas nenhum teste que instancia o
   * client à mão perceberia.
   */
  it('é resolvido pelo container de injeção do Nest', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        NfseNationalClient,
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();

    expect(moduleRef.get(NfseNationalClient)).toBeInstanceOf(NfseNationalClient);
  });

  describe('seleção de ambiente', () => {
    it('usa produção só quando a variável diz explicitamente', () => {
      expect(clientWith('PRODUCTION').environment).toBe(NFSE_ENVIRONMENT.PRODUCTION);
      expect(clientWith('production').isProduction).toBe(true);
    });

    /**
     * O default importa: variável ausente não pode significar emitir nota real.
     */
    it('cai para homologação quando a variável está ausente ou inválida', () => {
      expect(clientWith(undefined).environment).toBe(NFSE_ENVIRONMENT.HOMOLOGATION);
      expect(clientWith('').environment).toBe(NFSE_ENVIRONMENT.HOMOLOGATION);
      expect(clientWith('qualquer-coisa').environment).toBe(NFSE_ENVIRONMENT.HOMOLOGATION);
      expect(clientWith(undefined).isProduction).toBe(false);
    });
  });

  describe('interpretação da resposta de emissão', () => {
    const client = clientWith();

    it('autoriza só com 2xx e chave de acesso', () => {
      const result = client.interpretIssueResponse({
        status: 200,
        body: JSON.stringify({ chaveAcesso: ACCESS_KEY }),
        headers: {},
      });

      expect(result.authorized).toBe(true);
      expect(result.accessKey).toBe(ACCESS_KEY);
    });

    /**
     * 2xx sem chave não é autorização: marcar como emitida sem confirmação do
     * fisco é o pior defeito possível nesta feature.
     */
    it('não autoriza 2xx sem chave de acesso', () => {
      const result = client.interpretIssueResponse({
        status: 200,
        body: JSON.stringify({ mensagem: 'processando' }),
        headers: {},
      });

      expect(result.authorized).toBe(false);
    });

    it('extrai o motivo da lista erros[] devolvida pelo emissor real', () => {
      const result = clientWith().interpretIssueResponse({
        status: 400,
        body: JSON.stringify({
          tipoAmbiente: 2,
          idDPS: 'DPS431490221294043100011700001000000000000001',
          erros: [
            { Codigo: 'E0190', Descricao: 'CNPJ do tomador não encontrado no cadastro CNPJ.' },
            { Codigo: 'E0999', Descricao: 'Outro erro', Complemento: 'campo X' },
          ],
        }),
        headers: {},
      });

      expect(result.authorized).toBe(false);
      expect(result.code).toBe('E0190');
      expect(result.message).toBe(
        'E0190: CNPJ do tomador não encontrado no cadastro CNPJ.; E0999: Outro erro — campo X',
      );
    });

    it('limita a mensagem de erros[] ao tamanho da coluna do evento', () => {
      const result = clientWith().interpretIssueResponse({
        status: 400,
        body: JSON.stringify({ erros: [{ Codigo: 'E1', Descricao: 'x'.repeat(2000) }] }),
        headers: {},
      });

      expect(result.message?.length).toBeLessThanOrEqual(900);
    });

    it('prioriza Descricao sobre Mensagem quando o item de erros[] traz as duas', () => {
      const result = clientWith().interpretIssueResponse({
        status: 400,
        body: JSON.stringify({
          erros: [
            {
              Codigo: 'E0190',
              // Ordem proposital: `Mensagem` aparece antes de `Descricao` no
              // JSON. A prioridade é da lista de chaves pedida, não da ordem
              // em que o payload declara as propriedades.
              Mensagem: 'Erro genérico de validação',
              Descricao: 'CNPJ do tomador não encontrado no cadastro CNPJ.',
            },
          ],
        }),
        headers: {},
      });

      expect(result.message).toBe('E0190: CNPJ do tomador não encontrado no cadastro CNPJ.');
    });

    it('extrai código e mensagem da recusa', () => {
      const result = client.interpretIssueResponse({
        status: 400,
        body: JSON.stringify({ codigo: '2105', mensagem: 'Assinatura inválida' }),
        headers: {},
      });

      expect(result.authorized).toBe(false);
      expect(result.code).toBe('2105');
      expect(result.message).toBe('Assinatura inválida');
    });

    it('trata resposta não-JSON como recusa, preservando o corpo bruto', () => {
      const result = client.interpretIssueResponse({
        status: 500,
        body: '<html>erro do gateway</html>',
        headers: {},
      });

      expect(result.authorized).toBe(false);
      expect(result.message).toMatch(/formato inesperado/i);
      expect(result.raw.body).toContain('gateway');
    });

    describe('corpo fora de JSON: diagnóstico da rejeição', () => {
      let warn: jest.SpyInstance;

      beforeEach(() => {
        warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      });

      afterEach(() => warn.mockRestore());

      it('devolve status e corpo na mensagem do evento e loga um warn', () => {
        const result = client.interpretIssueResponse({
          status: 502,
          body: '<html>Bad Gateway</html>',
          headers: { authorization: 'Bearer segredo' },
        });

        expect(result.authorized).toBe(false);
        expect(result.message).toContain('formato inesperado');
        expect(result.message).toContain('HTTP 502');
        expect(result.message).toContain('<html>Bad Gateway</html>');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('502');
        expect(String(warn.mock.calls[0][0])).toContain('Bad Gateway');
        expect(String(warn.mock.calls[0][0])).not.toContain('segredo');
      });

      it('trunca o corpo para caber na coluna do evento', () => {
        const result = client.interpretIssueResponse({
          status: 500,
          body: 'x'.repeat(5000),
          headers: {},
        });

        expect(result.message!.length).toBeLessThanOrEqual(1000);
        expect(result.message).toContain('truncado');
      });

      it('registra corpo vazio de forma legível', () => {
        const result = client.interpretIssueResponse({
          status: 504,
          body: '',
          headers: {},
        });

        expect(result.message).toContain('HTTP 504');
        expect(result.message).toContain('corpo vazio');
      });
    });

    it('descompacta o XML da nota, que vem em GZip e base64', () => {
      const xml = '<NFSe><infNFSe>ok</infNFSe></NFSe>';
      const result = client.interpretIssueResponse({
        status: 200,
        body: JSON.stringify({
          chaveAcesso: ACCESS_KEY,
          nfseXmlGZipB64: gzipSync(Buffer.from(xml, 'utf8')).toString('base64'),
        }),
        headers: {},
      });

      expect(result.nfseXml).toBe(xml);
    });

    it('aceita XML não comprimido, sem perder a autorização', () => {
      const xml = '<NFSe>sem gzip</NFSe>';
      const result = client.interpretIssueResponse({
        status: 200,
        body: JSON.stringify({
          chaveAcesso: ACCESS_KEY,
          nfseXmlGZipB64: Buffer.from(xml, 'utf8').toString('base64'),
        }),
        headers: {},
      });

      expect(result.authorized).toBe(true);
      expect(result.nfseXml).toBe(xml);
    });
  });

  /**
   * Exercita o transporte de verdade contra um servidor mTLS local. É a única
   * forma de provar o handshake sem certificado ICP-Brasil real e credenciamento
   * no ambiente do fisco.
   */
  describe('interpretação da resposta de cancelamento', () => {
    const client = clientWith();

    it('registra só com 2xx, e devolve o identificador do evento quando vem', () => {
      const result = client.interpretCancelResponse({
        status: 200,
        body: JSON.stringify({ idEvento: `EVT${ACCESS_KEY}101101001` }),
        headers: {},
      });

      expect(result.registered).toBe(true);
      expect(result.eventId).toBe(`EVT${ACCESS_KEY}101101001`);
    });

    /**
     * Ao contrário da emissão, o registro do evento não depende de identificador
     * na resposta: o código é a confirmação, e o `Id` é conveniência de
     * auditoria. `201` vale tanto quanto `200`.
     */
    it('aceita 200 sem corpo legível como registro confirmado', () => {
      const result = client.interpretCancelResponse({
        status: 200,
        body: '',
        headers: {},
      });

      expect(result.registered).toBe(true);
    });

    it('aceita 201 como registro confirmado', () => {
      const result = client.interpretCancelResponse({
        status: 201,
        body: JSON.stringify({ idEvento: 'EVT1' }),
        headers: {},
      });

      expect(result.registered).toBe(true);
    });

    /**
     * `202 Accepted` diz que o pedido foi enfileirado, não avaliado. Contá-lo
     * como registro marcaria a nota como cancelada enquanto o fisco ainda a
     * mantém válida — o desfecho que este módulo existe para evitar.
     */
    it.each([202, 204, 299])('não dá %s como confirmação do registro', (status) => {
      const result = client.interpretCancelResponse({
        status,
        body: '',
        headers: {},
      });

      expect(result.registered).toBe(false);
      expect(result.message).toContain('sem confirmar o registro');
    });

    it('extrai o motivo da lista erros[] na recusa do cancelamento', () => {
      const result = clientWith().interpretCancelResponse({
        status: 400,
        body: JSON.stringify({ erros: [{ Codigo: 'E0840', Descricao: 'Evento não permitido.' }] }),
        headers: {},
      });

      expect(result.registered).toBe(false);
      expect(result.code).toBe('E0840');
      expect(result.message).toBe('E0840: Evento não permitido.');
    });

    it('trata recusa do fisco como não registrado, preservando código e mensagem', () => {
      const result = client.interpretCancelResponse({
        status: 422,
        body: JSON.stringify({
          codigo: '2301',
          mensagem: 'Prazo de cancelamento expirado',
        }),
        headers: {},
      });

      expect(result.registered).toBe(false);
      expect(result.code).toBe('2301');
      expect(result.message).toBe('Prazo de cancelamento expirado');
    });

    it('erro com corpo ilegível continua sendo recusa', () => {
      const result = client.interpretCancelResponse({
        status: 500,
        body: '<html>erro</html>',
        headers: {},
      });

      expect(result.registered).toBe(false);
      expect(result.message).toContain('formato inesperado');
    });

    describe('corpo fora de JSON: diagnóstico da rejeição', () => {
      let warn: jest.SpyInstance;

      beforeEach(() => {
        warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      });

      afterEach(() => warn.mockRestore());

      it('devolve status e corpo na mensagem do evento e loga um warn', () => {
        const result = client.interpretCancelResponse({
          status: 502,
          body: '<html>Bad Gateway</html>',
          headers: { authorization: 'Bearer segredo' },
        });

        expect(result.registered).toBe(false);
        expect(result.message).toContain('formato inesperado');
        expect(result.message).toContain('HTTP 502');
        expect(result.message).toContain('<html>Bad Gateway</html>');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('502');
        expect(String(warn.mock.calls[0][0])).toContain('Bad Gateway');
        expect(String(warn.mock.calls[0][0])).not.toContain('segredo');
      });

      it('explica o 202 ilegível sem perder o corpo', () => {
        const result = client.interpretCancelResponse({
          status: 202,
          body: 'enfileirado',
          headers: {},
        });

        expect(result.registered).toBe(false);
        expect(result.message).toContain('sem confirmar o registro');
        expect(result.message).toContain('enfileirado');
        expect(warn).toHaveBeenCalledTimes(1);
      });

      it('trunca o corpo para caber na coluna do evento', () => {
        const result = client.interpretCancelResponse({
          status: 500,
          body: 'x'.repeat(5000),
          headers: {},
        });

        expect(result.message!.length).toBeLessThanOrEqual(1000);
        expect(result.message).toContain('truncado');
      });

      it('não loga quando o registro é confirmado com corpo ilegível', () => {
        const result = client.interpretCancelResponse({
          status: 200,
          body: 'ok',
          headers: {},
        });

        expect(result.registered).toBe(true);
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('redirecionamento por configuração', () => {
    it('não redireciona quando a variável não está configurada', () => {
      expect(clientWith().configuredOverride).toBeNull();
    });

    it('lê host e porta do formato host:porta', () => {
      const client = clientWith({ NFSE_BASE_URL_OVERRIDE: 'localhost:8443' });

      expect(client.configuredOverride).toEqual({
        host: 'localhost',
        port: 8443,
      });
    });

    /**
     * A trava que importa: redirecionar em produção emitiria nota fiscal real
     * contra um host que não é o do fisco. Falhar alto é melhor que transmitir
     * para o lugar errado em silêncio.
     */
    it('recusa redirecionamento com ambiente de produção', () => {
      const client = clientWith({
        NFSE_ENVIRONMENT: 'PRODUCTION',
        NFSE_BASE_URL_OVERRIDE: 'localhost:8443',
      });

      expect(() => client.configuredOverride).toThrow(/PRODUCTION/);
    });

    it('recusa formato inválido em vez de adivinhar a porta', () => {
      const client = clientWith({ NFSE_BASE_URL_OVERRIDE: 'localhost' });

      expect(() => client.configuredOverride).toThrow(/host:porta/);
    });
  });

  describe('transporte mTLS', () => {
    let server: MtlsServerHandle;
    let credentials: NfseClientCredentials;

    beforeAll(() => {
      credentials = {
        pfx: createTestPkcs12({
          password: PASSWORD,
          companyName: 'empresa IMAGEM TESTE LTDA',
        }),
        passphrase: PASSWORD,
      };
    });

    afterEach(async () => {
      await server?.close();
    });

    it('apresenta o certificado do cliente no handshake', async () => {
      server = await startMtlsServer({
        routes: {
          'POST /SefinNacional/nfse': {
            status: 200,
            body: JSON.stringify({ chaveAcesso: ACCESS_KEY }),
          },
        },
      });

      const result = await clientWith().issue({
        signedDpsXml: '<DPS>assinada</DPS>',
        credentials,
        baseUrlOverride: {
          host: server.host,
          port: server.port,
          rejectUnauthorized: false,
        },
      });

      expect(result.authorized).toBe(true);
      expect(result.accessKey).toBe(ACCESS_KEY);

      // O servidor viu o certificado — prova que o mTLS aconteceu.
      expect(server.received).toHaveLength(1);
      expect(server.received[0].clientCertificateSubject).toContain('empresa IMAGEM TESTE LTDA');
    });

    it('chama a emissão sob o prefixo do serviço, não na raiz do host', async () => {
      server = await startMtlsServer({
        routes: {
          'POST /SefinNacional/nfse': {
            status: 200,
            body: JSON.stringify({ chaveAcesso: ACCESS_KEY }),
          },
        },
      });

      await clientWith().issue({
        signedDpsXml: '<DPS>assinada</DPS>',
        credentials,
        baseUrlOverride: { host: server.host, port: server.port, rejectUnauthorized: false },
      });

      expect(server.received[0].url).toBe('/SefinNacional/nfse');
    });

    it('envia a DPS assinada em gzip mais base64, como o nome do campo declara', async () => {
      server = await startMtlsServer({
        routes: {
          'POST /SefinNacional/nfse': {
            status: 200,
            body: JSON.stringify({ chaveAcesso: ACCESS_KEY }),
          },
        },
      });

      const signed = '<DPS versao="1.01">conteudo assinado</DPS>';
      await clientWith().issue({
        signedDpsXml: signed,
        credentials,
        baseUrlOverride: {
          host: server.host,
          port: server.port,
          rejectUnauthorized: false,
        },
      });

      const sent = JSON.parse(server.received[0].body) as {
        dpsXmlGZipB64: string;
      };

      // Base64 puro passaria por qualquer asserção de "chegou o XML certo", e o
      // fisco recusaria por formato. O teste confere a compactação de propósito.
      const compressed = Buffer.from(sent.dpsXmlGZipB64, 'base64');
      expect(gunzipSync(compressed).toString('utf8')).toBe(signed);
      expect(compressed.toString('utf8')).not.toContain('<DPS');
    });

    it('propaga recusa do fisco sem inventar autorização', async () => {
      server = await startMtlsServer({
        routes: {
          'POST /SefinNacional/nfse': {
            status: 422,
            body: JSON.stringify({
              codigo: '2105',
              mensagem: 'Assinatura inválida',
            }),
          },
        },
      });

      const result = await clientWith().issue({
        signedDpsXml: '<DPS/>',
        credentials,
        baseUrlOverride: {
          host: server.host,
          port: server.port,
          rejectUnauthorized: false,
        },
      });

      expect(result.authorized).toBe(false);
      expect(result.code).toBe('2105');
    });

    describe('cancelamento por evento', () => {
      it('posta o pedido na rota do evento da nota, em gzip mais base64', async () => {
        server = await startMtlsServer({
          routes: {
            [`POST /SefinNacional/nfse/${ACCESS_KEY}/eventos`]: {
              status: 200,
              body: JSON.stringify({ idEvento: `EVT${ACCESS_KEY}101101001` }),
            },
          },
        });

        const signed = '<pedRegEvento versao="1.01">assinado</pedRegEvento>';

        const result = await clientWith().cancel({
          accessKey: ACCESS_KEY,
          signedEventXml: signed,
          credentials,
          baseUrlOverride: {
            host: server.host,
            port: server.port,
            rejectUnauthorized: false,
          },
        });

        expect(result.registered).toBe(true);
        expect(server.received[0].url).toBe(`/SefinNacional/nfse/${ACCESS_KEY}/eventos`);
        expect(server.received[0].clientCertificateSubject).toContain('empresa IMAGEM TESTE LTDA');

        const sent = JSON.parse(server.received[0].body) as {
          pedidoRegistroEventoXmlGZipB64: string;
        };
        const compressed = Buffer.from(sent.pedidoRegistroEventoXmlGZipB64, 'base64');
        expect(gunzipSync(compressed).toString('utf8')).toBe(signed);
        expect(compressed.toString('utf8')).not.toContain('<pedRegEvento');
      });

      /**
       * `access_key` é `VarChar(60)` gravado como o fisco devolveu. Chave com
       * espaço faria o `httpsRequest` estourar `ERR_UNESCAPED_CHARACTERS`, que
       * o service reportaria como indisponibilidade do fisco — diagnóstico
       * errado para um problema de dado.
       */
      it('manda só os dígitos da chave no caminho, mesmo com formatação gravada', async () => {
        server = await startMtlsServer({
          routes: {
            [`POST /SefinNacional/nfse/${ACCESS_KEY}/eventos`]: {
              status: 200,
              body: JSON.stringify({ idEvento: 'EVT1' }),
            },
          },
        });

        const result = await clientWith().cancel({
          accessKey: `${ACCESS_KEY.slice(0, 25)} ${ACCESS_KEY.slice(25)}`,
          signedEventXml: '<pedRegEvento/>',
          credentials,
          baseUrlOverride: {
            host: server.host,
            port: server.port,
            rejectUnauthorized: false,
          },
        });

        expect(result.registered).toBe(true);
        expect(server.received[0].url).toBe(`/SefinNacional/nfse/${ACCESS_KEY}/eventos`);
      });

      it('não dá a nota por cancelada quando o fisco recusa', async () => {
        server = await startMtlsServer({
          routes: {
            [`POST /SefinNacional/nfse/${ACCESS_KEY}/eventos`]: {
              status: 422,
              body: JSON.stringify({
                codigo: '2301',
                mensagem: 'NFS-e já cancelada',
              }),
            },
          },
        });

        const result = await clientWith().cancel({
          accessKey: ACCESS_KEY,
          signedEventXml: '<pedRegEvento/>',
          credentials,
          baseUrlOverride: {
            host: server.host,
            port: server.port,
            rejectUnauthorized: false,
          },
        });

        expect(result.registered).toBe(false);
        expect(result.code).toBe('2301');
      });
    });

    describe('idempotência por consulta de DPS', () => {
      const dpsId = '431490221234567800019500001000000000000001';

      it('reconhece DPS que já virou nota', async () => {
        server = await startMtlsServer({
          routes: {
            [`GET /SefinNacional/dps/${dpsId}`]: {
              status: 200,
              body: JSON.stringify({ chaveAcesso: ACCESS_KEY }),
            },
          },
        });

        const found = await clientWith().findExistingByDpsId({
          dpsId,
          credentials,
          baseUrlOverride: {
            host: server.host,
            port: server.port,
            rejectUnauthorized: false,
          },
        });

        expect(found).toEqual({ exists: true, accessKey: ACCESS_KEY });
        expect(server.received[0].url).toBe(`/SefinNacional/dps/${dpsId}`);
      });

      it('trata 404 como DPS ainda não transmitida', async () => {
        server = await startMtlsServer({ routes: {} });

        const found = await clientWith().findExistingByDpsId({
          dpsId,
          credentials,
          baseUrlOverride: {
            host: server.host,
            port: server.port,
            rejectUnauthorized: false,
          },
        });

        expect(found.exists).toBe(false);
      });

      /**
       * Resposta inesperada não pode virar "não existe": seguir para reenvio
       * nessa situação é exatamente como se duplica nota fiscal.
       */
      it('lança em situação indeterminada, em vez de assumir que não existe', async () => {
        server = await startMtlsServer({
          routes: {
            [`GET /SefinNacional/dps/${dpsId}`]: { status: 503, body: 'indisponivel' },
          },
        });

        await expect(
          clientWith().findExistingByDpsId({
            dpsId,
            credentials,
            baseUrlOverride: {
              host: server.host,
              port: server.port,
              rejectUnauthorized: false,
            },
          }),
        ).rejects.toThrow(/indeterminada/i);
      });
    });

    it('recusa consulta 200 sem chave antes de permitir retransmissão', async () => {
      const dpsId = '1'.repeat(42);
      server = await startMtlsServer({
        routes: { [`GET /SefinNacional/dps/${dpsId}`]: { status: 200, body: '{}' } },
      });
      await expect(
        clientWith().findExistingByDpsId({
          dpsId,
          credentials,
          baseUrlOverride: { host: server.host, port: server.port, rejectUnauthorized: false },
        }),
      ).rejects.toThrow(/indeterminada/);
    });

    it('não expõe senha nem certificado na mensagem de erro de rede', async () => {
      server = await startMtlsServer({ routes: {} });
      const port = server.port;
      await server.close();

      // Porta fechada força erro de conexão.
      try {
        await clientWith().requestWithCertificate({
          method: 'GET',
          path: '/nfse',
          credentials,
          baseUrlOverride: { host: '127.0.0.1', port, rejectUnauthorized: false },
        });
        throw new Error('deveria ter falhado');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain(PASSWORD);
        expect(message).not.toContain(credentials.pfx.toString('base64').slice(0, 24));
      }

      server = await startMtlsServer({ routes: {} });
    });
  });
});
