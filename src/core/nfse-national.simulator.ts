import { createServer } from 'node:https';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Logger } from '@nestjs/common';
import * as forge from 'node-forge';
import { SEFIN_PATH_PREFIX } from './nfse-national.client';
import { isXmlLintAvailable, PED_REG_EVENTO_SCHEMA, validateAgainstXsd } from './xsd-validator';

/**
 * Simulador do Emissor Nacional de NFS-e, para desenvolvimento.
 *
 * Existe porque transmitir ao ambiente do fisco exige certificado ICP-Brasil e
 * credenciamento do CNPJ — coisas que não se resolvem em uma tarde. Sem isto, o
 * fluxo de emissão só seria exercitável com o cliente HTTP mockado, e mock não
 * prova handshake mTLS, compactação, nem leiaute.
 *
 * **Não é um mock complacente.** Ele recusa o que o fisco recusaria:
 *
 * - exige certificado de cliente no handshake — sem mTLS não há resposta;
 * - exige que o corpo venha em GZip mais base64, como o nome do campo declara;
 * - valida a DPS e o pedido de evento contra o **esquema oficial** versionado
 *   no repositório;
 * - exige assinatura XMLDSIG presente, com erro 2104 quando falta;
 * - confere que o `Id` da DPS tem o prefixo `DPS` e 42 dígitos, e o do pedido de
 *   evento o prefixo `PRE` e 56 dígitos;
 * - recusa cancelar nota que ele não emitiu, e recusa cancelar duas vezes.
 *
 * O que ele **não** prova: as regras de negócio do fisco (CNPJ credenciado,
 * município aderido, código de tributação existente na tabela nacional, sequência
 * de numeração aceita). Nota autorizada aqui não é nota válida.
 *
 * A CLI que o levanta em desenvolvimento é `scripts/simulador-nfse-nacional.ts`.
 * Este módulo é exportável de propósito: um teste de integração o levanta e
 * dirige o cliente real através dele, então o simulador é ele mesmo verificado
 * pela suíte, em vez de ser um script que só funciona na mão.
 */

const logger = new Logger('NfseSimulator');

export interface NfseSimulatorOptions {
  /** Falha de resposta após efeito fiscal, para testar reconciliação. */
  failAfterIssueOnce?: boolean;
  failAfterCancelOnce?: boolean;
  listenHost?: string;
  /** `0` deixa o sistema escolher a porta — é o que o teste usa. */
  port?: number;
  /** Códigos LC 116 a recusar, para exercitar rejeição parcial do lote. */
  reject?: string[];
  /** Silencia o log; o teste não precisa da narração. */
  quiet?: boolean;
}

export interface NfseSimulatorHandle {
  host: string;
  port: number;
  /** Emissões autorizadas, por `Id` da DPS. */
  issued: Map<string, { accessKey: string; nfseXml: string }>;
  /** Cancelamentos registrados, por chave de acesso. */
  canceled: Map<string, { reasonCode: string; reason: string }>;
  close: () => Promise<void>;
}

interface Options {
  port: number;
  reject: string[];
  quiet: boolean;
}

/** Par autoassinado para o simulador. O cliente aceita sem validar a cadeia. */
function createSelfSignedPair(): { keyPem: string; certPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  const attrs = [{ name: 'commonName', value: 'localhost' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] },
  ]);
  cert.sign(keys.privateKey);

  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

/**
 * Chave de acesso da NFS-e: 50 dígitos. A composição real inclui município,
 * inscrição, número e dígito verificador; aqui o formato é respeitado e o
 * conteúdo é derivado do `Id` da DPS, para que a chave seja estável entre
 * chamadas — é o que permite a consulta por DPS funcionar.
 */
function buildAccessKey(dpsId: string): string {
  return `${dpsId.padEnd(48, '0').slice(0, 48)}01`;
}

function extract(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match ? match[1] : null;
}

interface Rejection {
  status: number;
  code: string;
  message: string;
}

/**
 * Confere a DPS como o fisco conferiria: formato do envelope, leiaute e
 * assinatura. Devolve `null` quando está tudo certo.
 */
function inspect(
  signedXml: string,
  options: Options,
): { rejection: Rejection | null; dpsId: string | null; serviceCode: string } {
  const idMatch = /Id="DPS(\d{42})"/.exec(signedXml);
  const serviceCode = extract(signedXml, 'cTribNac') ?? '(sem cTribNac)';

  if (!idMatch) {
    return {
      rejection: {
        status: 422,
        code: '1001',
        message: 'Identificação da DPS ausente ou fora do formato DPS mais 42 dígitos',
      },
      dpsId: null,
      serviceCode,
    };
  }

  const dpsId = idMatch[1];

  // 2104 é o código real do fisco para assinatura ausente.
  if (!signedXml.includes('<Signature') && !signedXml.includes(':Signature')) {
    return {
      rejection: {
        status: 422,
        code: '2104',
        message: 'Assinatura digital ausente na DPS',
      },
      dpsId,
      serviceCode,
    };
  }

  if (isXmlLintAvailable()) {
    const result = validateAgainstXsd(signedXml);

    if (!result.valid) {
      return {
        rejection: {
          status: 422,
          code: '1002',
          message: `DPS não valida contra o esquema oficial: ${result.errors.trim().split('\n')[0]}`,
        },
        dpsId,
        serviceCode,
      };
    }
  }

  // Rejeição forçada por linha de comando, para exercitar lote parcialmente
  // rejeitado sem precisar corromper dado de propósito.
  const lc = /^(\d{2})(\d{2})/.exec(serviceCode);
  const lcCode = lc ? `${Number(lc[1])}.${lc[2]}` : null;

  if (lcCode && options.reject.includes(lcCode)) {
    return {
      rejection: {
        status: 422,
        code: '9999',
        message: `Rejeição simulada para o item ${lcCode} (--rejeitar)`,
      },
      dpsId,
      serviceCode,
    };
  }

  return { rejection: null, dpsId, serviceCode };
}

function buildNfseXml(dpsId: string, accessKey: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">' +
    `<infNFSe Id="NFS${accessKey}">` +
    `<chNFSe>${accessKey}</chNFSe>` +
    `<idDPS>${dpsId}</idDPS>` +
    '<simulador>Documento gerado pelo simulador de desenvolvimento. Sem valor fiscal.</simulador>' +
    '</infNFSe>' +
    '</NFSe>'
  );
}

export async function startNfseSimulator(
  input: NfseSimulatorOptions = {},
): Promise<NfseSimulatorHandle> {
  let failIssue = input.failAfterIssueOnce ?? false;
  let failCancel = input.failAfterCancelOnce ?? false;
  const options: Options = {
    port: input.port ?? 8443,
    reject: input.reject ?? [],
    quiet: input.quiet ?? false,
  };

  const log = (message: string) => {
    if (!options.quiet) {
      logger.log(message);
    }
  };

  const { keyPem, certPem } = createSelfSignedPair();

  /** Notas já emitidas, por `Id` da DPS. Base da consulta de idempotência. */
  const issued = new Map<string, { accessKey: string; nfseXml: string }>();

  /** Cancelamentos registrados, por chave de acesso. */
  const canceled = new Map<string, { reasonCode: string; reason: string }>();

  if (!isXmlLintAvailable()) throw new Error('xmllint obrigatório para iniciar o simulador');

  const server = createServer(
    {
      key: keyPem,
      cert: certPem,
      // Exige certificado de cliente sem validar a cadeia: o que interessa é
      // provar que o `.pfx` foi apresentado, não emular a ICP-Brasil.
      requestCert: true,
      rejectUnauthorized: false,
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const peer = (
          req.socket as unknown as {
            getPeerCertificate?: () => { subject?: { CN?: string } };
          }
        ).getPeerCertificate?.();

        const holder = peer?.subject?.CN;
        const reply = (status: number, payload: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        // Sem certificado de cliente não há resposta: é o que o fisco faz, e é
        // metade do que este simulador existe para provar.
        if (!holder) {
          log(`✗ ${req.method} ${req.url} — sem certificado de cliente`);
          reply(401, {
            codigo: '0001',
            mensagem: 'Certificado de cliente não apresentado no handshake',
          });
          return;
        }

        const url = req.url ?? '';
        // Mesmas rotas do SEFIN real, sob o prefixo do serviço: rota na raiz do
        // host responde 404, como no fisco, para o defeito não ficar escondido.
        const route = url.startsWith(`${SEFIN_PATH_PREFIX}/`)
          ? url.slice(SEFIN_PATH_PREFIX.length)
          : '';

        if (req.method === 'POST' && route === '/nfse') {
          handleIssue(Buffer.concat(chunks).toString('utf8'), options, {
            holder,
            reply: (status, payload) => {
              if (status === 200 && failIssue) {
                failIssue = false;
                reply(503, { mensagem: 'Resposta de teste interrompida após autorização' });
              } else reply(status, payload);
            },
            issued,
            log,
          });
          return;
        }

        const eventMatch = /^\/nfse\/(\d{50})\/eventos$/.exec(route);

        if (req.method === 'POST' && eventMatch) {
          handleCancel(Buffer.concat(chunks).toString('utf8'), eventMatch[1], {
            holder,
            reply: (status, payload) => {
              if (status === 200 && failCancel) {
                failCancel = false;
                reply(503, { mensagem: 'Resposta de teste interrompida após cancelamento' });
              } else reply(status, payload);
            },
            issued,
            canceled,
            log,
          });
          return;
        }

        const queryEvent = /^\/nfse\/(\d{50})\/eventos\/101101\/1$/.exec(route);
        if (req.method === 'GET' && queryEvent) {
          const found = canceled.get(queryEvent[1]);
          if (!found) reply(404, { codigo: '404', mensagem: 'Evento não encontrado' });
          else
            reply(200, {
              eventos: [
                {
                  eventoXmlGZipB64: gzipSync(
                    Buffer.from(`<evento><chNFSe>${queryEvent[1]}</chNFSe><e101101/></evento>`),
                  ).toString('base64'),
                },
              ],
            });
          return;
        }
        const queryInvoice = /^\/nfse\/(\d{50})$/.exec(route);
        if (req.method === 'GET' && queryInvoice) {
          const found = [...issued.values()].find((item) => item.accessKey === queryInvoice[1]);
          if (!found) reply(404, { codigo: '404', mensagem: 'Nota não encontrada' });
          else
            reply(200, {
              chaveAcesso: found.accessKey,
              nfseXmlGZipB64: gzipSync(Buffer.from(found.nfseXml)).toString('base64'),
            });
          return;
        }

        const dpsMatch = /^\/dps\/(\d{42})$/.exec(route);

        if (dpsMatch && (req.method === 'GET' || req.method === 'HEAD')) {
          const found = issued.get(dpsMatch[1]);
          log(`· ${req.method} ${url} — ${found ? 'já emitida' : 'não encontrada'}`);

          if (!found) {
            reply(404, {
              codigo: '404',
              mensagem: 'DPS ainda não convertida em NFS-e',
            });
            return;
          }

          reply(200, { chaveAcesso: found.accessKey });
          return;
        }

        log(`? ${req.method} ${url} — rota não implementada`);
        reply(404, {
          codigo: '404',
          mensagem: `Rota não implementada no simulador: ${req.method} ${url}`,
        });
      });
    },
  );

  await new Promise<void>((resolve) =>
    server.listen(options.port, input.listenHost ?? '127.0.0.1', resolve),
  );

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  if (!options.quiet) {
    logger.log(
      `\n🧪 Simulador do Emissor Nacional ouvindo em https://localhost:${port}\n` +
        `   Configure no .env do backend: NFSE_BASE_URL_OVERRIDE=localhost:${port}\n` +
        (options.reject.length > 0
          ? `   Rejeitando os itens: ${options.reject.join(', ')}\n`
          : '   Autorizando tudo o que passar pelo esquema oficial\n') +
        '   Notas autorizadas aqui NÃO têm valor fiscal.\n',
    );
  }

  return {
    host: '127.0.0.1',
    port,
    issued,
    canceled,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function handleIssue(
  rawBody: string,
  options: Options,
  ctx: {
    holder: string;
    reply: (status: number, payload: unknown) => void;
    issued: Map<string, { accessKey: string; nfseXml: string }>;
    log: (message: string) => void;
  },
): void {
  let payload: { dpsXmlGZipB64?: string };

  try {
    payload = JSON.parse(rawBody) as { dpsXmlGZipB64?: string };
  } catch {
    ctx.log('✗ POST /nfse — corpo não é JSON');
    ctx.reply(400, { codigo: '0002', mensagem: 'Corpo não é JSON válido' });
    return;
  }

  if (!payload.dpsXmlGZipB64) {
    ctx.log('✗ POST /nfse — campo dpsXmlGZipB64 ausente');
    ctx.reply(400, { codigo: '0003', mensagem: 'Campo dpsXmlGZipB64 ausente' });
    return;
  }

  let signedXml: string;

  try {
    signedXml = gunzipSync(Buffer.from(payload.dpsXmlGZipB64, 'base64')).toString('utf8');
  } catch {
    // Recusa deliberada: aceitar base64 puro esconderia justamente o erro de
    // não compactar, que o nome do campo já anuncia.
    ctx.log('✗ POST /nfse — conteúdo não está em GZip');
    ctx.reply(400, {
      codigo: '0004',
      mensagem: 'Conteúdo de dpsXmlGZipB64 não está compactado em GZip antes do base64',
    });
    return;
  }

  const { rejection, dpsId, serviceCode } = inspect(signedXml, options);

  if (rejection) {
    ctx.log(
      `✗ POST /nfse — recusada (${rejection.code}) item ${serviceCode}: ${rejection.message}`,
    );
    ctx.reply(rejection.status, {
      codigo: rejection.code,
      mensagem: rejection.message,
    });
    return;
  }

  const id = dpsId as string;
  const existing = ctx.issued.get(id);

  // Idempotência do lado do fisco: a mesma DPS não gera duas notas. É o que o
  // reenvio do serviço depende para não duplicar.
  if (existing) {
    ctx.log(`↺ POST /nfse — DPS ${id} já emitida, devolvendo a mesma nota`);
    ctx.reply(200, {
      chaveAcesso: existing.accessKey,
      nfseXmlGZipB64: gzipSync(Buffer.from(existing.nfseXml, 'utf8')).toString('base64'),
    });
    return;
  }

  const accessKey = buildAccessKey(id);
  const nfseXml = buildNfseXml(id, accessKey);
  ctx.issued.set(id, { accessKey, nfseXml });

  ctx.log(
    `✓ POST /nfse — autorizada item ${serviceCode}, chave ${accessKey} (cliente: ${ctx.holder})`,
  );

  ctx.reply(200, {
    chaveAcesso: accessKey,
    nfseXmlGZipB64: gzipSync(Buffer.from(nfseXml, 'utf8')).toString('base64'),
  });
}

/**
 * Pedido de registro do evento de cancelamento (`e101101`).
 *
 * Recusa o que o fisco recusaria, e nesta ordem: envelope, leiaute, assinatura,
 * existência da nota e cancelamento repetido. A ordem importa — documento
 * malformado não chega a ser confrontado com o estado da nota.
 */
function handleCancel(
  rawBody: string,
  accessKey: string,
  ctx: {
    holder: string;
    reply: (status: number, payload: unknown) => void;
    issued: Map<string, { accessKey: string; nfseXml: string }>;
    canceled: Map<string, { reasonCode: string; reason: string }>;
    log: (message: string) => void;
  },
): void {
  let payload: { pedidoRegistroEventoXmlGZipB64?: string };

  try {
    payload = JSON.parse(rawBody) as {
      pedidoRegistroEventoXmlGZipB64?: string;
    };
  } catch {
    ctx.log('✗ POST evento — corpo não é JSON');
    ctx.reply(400, { codigo: '0002', mensagem: 'Corpo não é JSON válido' });
    return;
  }

  if (!payload.pedidoRegistroEventoXmlGZipB64) {
    ctx.log('✗ POST evento — campo pedidoRegistroEventoXmlGZipB64 ausente');
    ctx.reply(400, {
      codigo: '0003',
      mensagem: 'Campo pedidoRegistroEventoXmlGZipB64 ausente',
    });
    return;
  }

  let signedXml: string;

  try {
    signedXml = gunzipSync(Buffer.from(payload.pedidoRegistroEventoXmlGZipB64, 'base64')).toString(
      'utf8',
    );
  } catch {
    ctx.log('✗ POST evento — conteúdo não está em GZip');
    ctx.reply(400, {
      codigo: '0004',
      mensagem:
        'Conteúdo de pedidoRegistroEventoXmlGZipB64 não está compactado em GZip antes do base64',
    });
    return;
  }

  if (!/Id="PRE(\d{56})"/.test(signedXml)) {
    ctx.log('✗ POST evento — Id do pedido fora do formato');
    ctx.reply(422, {
      codigo: '1001',
      mensagem: 'Identificação do pedido de evento ausente ou fora do formato PRE mais 56 dígitos',
    });
    return;
  }

  // 2104 é o código real do fisco para assinatura ausente. Vale para o evento
  // tanto quanto para a DPS: cancelar é ato que precisa provar quem pediu.
  if (!signedXml.includes('<Signature') && !signedXml.includes(':Signature')) {
    ctx.log('✗ POST evento — sem assinatura');
    ctx.reply(422, {
      codigo: '2104',
      mensagem: 'Assinatura digital ausente no pedido de registro de evento',
    });
    return;
  }

  if (isXmlLintAvailable()) {
    const result = validateAgainstXsd(signedXml, PED_REG_EVENTO_SCHEMA);

    if (!result.valid) {
      ctx.log('✗ POST evento — não valida contra o esquema oficial');
      ctx.reply(422, {
        codigo: '1002',
        mensagem: `Pedido de evento não valida contra o esquema oficial: ${result.errors.trim().split('\n')[0]}`,
      });
      return;
    }
  }

  // A chave do XML tem que ser a mesma da rota: divergir significa pedir o
  // cancelamento de uma nota e assinar o de outra.
  const declaredKey = extract(signedXml, 'chNFSe');

  if (declaredKey !== accessKey) {
    ctx.log('✗ POST evento — chave do XML diverge da chave da rota');
    ctx.reply(422, {
      codigo: '1003',
      mensagem: 'A chave de acesso declarada no pedido não é a mesma da nota informada',
    });
    return;
  }

  const exists = [...ctx.issued.values()].some((invoice) => invoice.accessKey === accessKey);

  if (!exists) {
    ctx.log(`✗ POST evento — nota ${accessKey} não encontrada`);
    ctx.reply(404, {
      codigo: '404',
      mensagem: 'NFS-e não encontrada para a chave informada',
    });
    return;
  }

  if (ctx.canceled.has(accessKey)) {
    ctx.log(`✗ POST evento — nota ${accessKey} já cancelada`);
    ctx.reply(422, {
      codigo: '2301',
      mensagem: 'NFS-e já cancelada; não cabe novo evento de cancelamento',
    });
    return;
  }

  const reasonCode = extract(signedXml, 'cMotivo') ?? '9';
  const reason = extract(signedXml, 'xMotivo') ?? '';

  ctx.canceled.set(accessKey, { reasonCode, reason });

  ctx.log(
    `✓ POST evento — cancelamento registrado para ${accessKey}, motivo ${reasonCode} (cliente: ${ctx.holder})`,
  );

  ctx.reply(200, {
    idEvento: `EVT${accessKey}101101001`,
    mensagem: 'Evento de cancelamento registrado',
  });
}
