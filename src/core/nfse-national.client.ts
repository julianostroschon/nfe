import { request as httpsRequest } from 'node:https';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Cliente do Emissor Nacional de NFS-e.
 *
 * Usa `node:https` e **não** `fetch`: o padrão nacional exige mTLS, e o `fetch`
 * do Node só faria isso por um `dispatcher` do undici, API não padronizada. O TLS
 * do Node aceita PKCS#12 direto, então o `.pfx` decifrado vai como está — sem
 * extrair chave e certificado em PEM só para o transporte.
 *
 * Nenhum log, mensagem ou rastro carrega a senha ou o conteúdo do certificado.
 * O `pfx` e a `passphrase` entram nas opções de TLS e não são interpolados em
 * lugar nenhum.
 */

/** Ambientes do padrão nacional. `HOMOLOGATION` é a "produção restrita". */
export const NFSE_ENVIRONMENT = {
  HOMOLOGATION: 'HOMOLOGATION',
  PRODUCTION: 'PRODUCTION',
} as const;

export type NfseEnvironment = (typeof NFSE_ENVIRONMENT)[keyof typeof NFSE_ENVIRONMENT];

/**
 * Hosts por ambiente. O SEFIN recebe a emissão do contribuinte; o ADN é o
 * ambiente de distribuição, usado para consulta e reconciliação.
 */
const HOSTS: Record<NfseEnvironment, { sefin: string; adn: string }> = {
  HOMOLOGATION: {
    sefin: 'sefin.producaorestrita.nfse.gov.br',
    adn: 'adn.producaorestrita.nfse.gov.br',
  },
  PRODUCTION: {
    sefin: 'sefin.nfse.gov.br',
    adn: 'adn.nfse.gov.br',
  },
};

/**
 * Prefixo de caminho do serviço. O SEFIN Nacional roda sob `/SefinNacional` no
 * host — as rotas da API (`/nfse`, `/nfse/{chave}/eventos`, `/dps/{id}`) são
 * relativas a ele; chamar `/nfse` na raiz do host devolve 404 do IIS. O ADN não
 * usa prefixo.
 */
export const SEFIN_PATH_PREFIX = '/SefinNacional';

const PATH_PREFIX: Record<'sefin' | 'adn', string> = {
  sefin: SEFIN_PATH_PREFIX,
  adn: '',
};

const DEFAULT_TIMEOUT_MS = 60_000;
const ENV_KEY = 'NFSE_ENVIRONMENT';

/**
 * Redireciona as chamadas para outro host, no formato `host:porta`.
 *
 * Existe para o ambiente de desenvolvimento apontar ao simulador do Emissor
 * Nacional e exercitar o fluxo inteiro sem credenciamento. **Ignorado em
 * produção**, com recusa explícita: emitir nota de produção contra host
 * arbitrário é o pior desfecho possível deste código, e falhar alto é melhor
 * que transmitir para o lugar errado em silêncio.
 */
const BASE_URL_OVERRIDE_KEY = 'NFSE_BASE_URL_OVERRIDE';

export interface NfseClientCredentials {
  /** Conteúdo do `.pfx`, já decifrado. Nunca logado. */
  pfx: Buffer;
  /** Senha do `.pfx`. Nunca logada. */
  passphrase: string;
}

export interface NfseResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Retorno de `POST /nfse/{chave}/eventos`, o pedido de cancelamento. */
export interface NfseCancelResult {
  /** Verdadeiro só quando o fisco confirma o registro do evento. */
  registered: boolean;
  /** Identificador do evento registrado, quando devolvido. */
  eventId?: string;
  /** Código devolvido pelo fisco na recusa. */
  code?: string;
  /** Mensagem legível da recusa. */
  message?: string;
  /** Resposta bruta, para auditoria e diagnóstico. */
  raw: NfseResponse;
}

/** Retorno de `POST /nfse` quando o fisco autoriza. */
export interface NfseIssueResult {
  authorized: boolean;
  /** Chave de acesso da nota, quando autorizada. */
  accessKey?: string;
  /** XML da nota autorizada, já descompactado. */
  nfseXml?: string;
  /** Código devolvido pelo fisco na recusa. */
  code?: string;
  /** Mensagem legível da recusa. */
  message?: string;
  /** Resposta bruta, para auditoria e diagnóstico. */
  raw: NfseResponse;
}

@Injectable()
export class NfseNationalClient {
  /** Máximo do corpo bruto de resposta inesperada que vai para log e evento. */
  private static readonly UNEXPECTED_BODY_LIMIT = 500;

  /** Máximo da mensagem de recusa: a coluna `message` do evento tem 1000 caracteres. */
  private static readonly REJECTION_MESSAGE_LIMIT = 900;

  private readonly logger = new Logger(NfseNationalClient.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Ambiente ativo. Ausência da variável vale **homologação**, nunca produção:
   * o default de uma configuração faltante não pode ser emitir nota real.
   */
  get environment(): NfseEnvironment {
    const raw = this.configService.get<string>(ENV_KEY)?.trim().toUpperCase();
    return raw === NFSE_ENVIRONMENT.PRODUCTION
      ? NFSE_ENVIRONMENT.PRODUCTION
      : NFSE_ENVIRONMENT.HOMOLOGATION;
  }

  get isProduction(): boolean {
    return this.environment === NFSE_ENVIRONMENT.PRODUCTION;
  }

  /**
   * Redirecionamento configurado, quando existe e é permitido.
   *
   * Em produção a presença da variável é erro, e não algo a ignorar: quem a
   * configurou acredita que as chamadas vão para outro lugar. Emitir para o
   * fisco de verdade nesse estado seria a surpresa mais cara possível.
   */
  get configuredOverride(): { host: string; port: number } | null {
    const raw = this.configService.get<string>(BASE_URL_OVERRIDE_KEY)?.trim();

    if (!raw) {
      return null;
    }

    if (this.isProduction) {
      throw new Error(
        `${BASE_URL_OVERRIDE_KEY} está configurada com ${ENV_KEY}=PRODUCTION. ` +
          'Redirecionar a transmissão em produção emitiria nota fiscal real ' +
          'contra um host que não é o do fisco. Remova uma das duas.',
      );
    }

    const [host, port] = raw.split(':');

    if (!host || !port || Number.isNaN(Number(port))) {
      throw new Error(
        `${BASE_URL_OVERRIDE_KEY} deve estar no formato host:porta (recebido: ${raw})`,
      );
    }

    return { host, port: Number(port) };
  }

  private hostFor(service: 'sefin' | 'adn'): string {
    return HOSTS[this.environment][service];
  }

  /**
   * Requisição sobre mTLS. Base de todas as chamadas.
   *
   * `baseUrlOverride` existe para o teste apontar a um servidor mTLS local — é o
   * que permite exercitar o handshake de verdade sem depender do ambiente do
   * fisco, que exige certificado ICP-Brasil real e credenciamento.
   */
  async requestWithCertificate(params: {
    method: 'GET' | 'POST' | 'HEAD';
    path: string;
    credentials: NfseClientCredentials;
    body?: string;
    service?: 'sefin' | 'adn';
    timeoutMs?: number;
    baseUrlOverride?: {
      host: string;
      port: number;
      rejectUnauthorized?: boolean;
    };
  }): Promise<NfseResponse> {
    const {
      method,
      path,
      credentials,
      body,
      service = 'sefin',
      timeoutMs = DEFAULT_TIMEOUT_MS,
      baseUrlOverride,
    } = params;

    // Precedência: o override do chamador (usado pelos testes) vence o
    // configurado por ambiente, que vence o host oficial.
    const configured = baseUrlOverride ?? this.configuredOverride ?? undefined;

    const host = configured?.host ?? this.hostFor(service);
    const fullPath = `${PATH_PREFIX[service]}${path}`;
    const port = configured?.port ?? 443;
    // Certificado autoassinado só é aceito quando o destino não é o fisco.
    const rejectUnauthorized = baseUrlOverride?.rejectUnauthorized ?? !configured;

    return await new Promise<NfseResponse>((resolve, reject) => {
      const req = httpsRequest(
        {
          host,
          port,
          path: fullPath,
          method,
          // O material do certificado entra só aqui. Não é logado nem serializado.
          pfx: credentials.pfx,
          passphrase: credentials.passphrase,
          rejectUnauthorized,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('error', reject);
          res.on('aborted', () => reject(new Error('Resposta fiscal interrompida')));
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) req.destroy(new Error('Resposta fiscal excede limite'));
            else chunks.push(chunk);
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              headers: res.headers,
            }),
          );
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Tempo esgotado após ${timeoutMs}ms`));
      });

      // Só o nome e a mensagem do erro de rede; nunca as opções de TLS, que
      // carregam o certificado.
      req.on('error', (error) => {
        this.logger.warn(
          `Falha de comunicação com o emissor nacional (${method} ${fullPath}): ${error.message}`,
        );
        reject(error);
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  /**
   * Emite a NFS-e a partir da DPS assinada. A emissão é síncrona: a resposta já
   * traz a nota autorizada ou a recusa.
   *
   * O XML da DPS vai em base64 dentro do JSON, conforme o contrato da API.
   */
  async issue(params: {
    signedDpsXml: string;
    credentials: NfseClientCredentials;
    baseUrlOverride?: {
      host: string;
      port: number;
      rejectUnauthorized?: boolean;
    };
  }): Promise<NfseIssueResult> {
    // GZip **e depois** base64. O nome do campo diz isso, e a resposta usa a
    // mesma convenção — mandar base64 puro num campo `...GZipB64` faz o fisco
    // tentar descompactar texto plano e recusar com erro de formato, o que é
    // caro de diagnosticar porque o XML em si está correto.
    const body = JSON.stringify({
      dpsXmlGZipB64: gzipSync(Buffer.from(params.signedDpsXml, 'utf8')).toString('base64'),
    });

    const raw = await this.requestWithCertificate({
      method: 'POST',
      path: '/nfse',
      body,
      credentials: params.credentials,
      baseUrlOverride: params.baseUrlOverride,
    });

    return this.interpretIssueResponse(raw);
  }

  /**
   * Pede o registro do evento de cancelamento da nota (`e101101`).
   *
   * Cancelar não altera a nota: o padrão registra um **evento** vinculado à
   * chave de acesso, e o documento autorizado continua intacto. Mesma convenção
   * de envelope da emissão — GZip e depois base64 —, que é o que o nome do
   * campo declara.
   */
  async cancel(params: {
    accessKey: string;
    signedEventXml: string;
    credentials: NfseClientCredentials;
    baseUrlOverride?: {
      host: string;
      port: number;
      rejectUnauthorized?: boolean;
    };
  }): Promise<NfseCancelResult> {
    const body = JSON.stringify({
      pedidoRegistroEventoXmlGZipB64: gzipSync(Buffer.from(params.signedEventXml, 'utf8')).toString(
        'base64',
      ),
    });

    // Só os dígitos no caminho, como o documento assinado também faz: chave
    // gravada com espaço ou formatação faria o `httpsRequest` estourar
    // `ERR_UNESCAPED_CHARACTERS`, que o chamador reportaria como
    // indisponibilidade do fisco — diagnóstico errado para um problema de dado.
    const accessKey = params.accessKey.replace(/\D/g, '');

    const raw = await this.requestWithCertificate({
      method: 'POST',
      path: `/nfse/${accessKey}/eventos`,
      body,
      credentials: params.credentials,
      baseUrlOverride: params.baseUrlOverride,
    });

    return this.interpretCancelResponse(raw);
  }

  /**
   * Descreve uma resposta cujo corpo não é JSON: status HTTP e corpo bruto
   * truncado, para a mensagem do evento da nota e para um `warn` no log.
   *
   * Causa raiz: os dois `catch` do `JSON.parse` devolviam só a
   * mensagem genérica e descartavam `raw.status` e `raw.body`, então uma rejeição
   * causada por gateway ou página de erro HTTP não deixava rastro para
   * diagnóstico — nem no log, nem no Histórico da nota.
   *
   * Só status e corpo entram: os headers ficam de fora, porque podem carregar
   * credencial. O limite deixa a mensagem final dentro dos 1000 caracteres da
   * coluna `message` do evento.
   */
  private describeUnexpectedBody(operation: 'emissão' | 'cancelamento', raw: NfseResponse): string {
    const limit = NfseNationalClient.UNEXPECTED_BODY_LIMIT;
    const body = raw.body ?? '';
    const truncated = body.length > limit;
    const shown = truncated ? body.slice(0, limit) : body;
    const detail = body.trim()
      ? `corpo: ${shown}${truncated ? `… (truncado em ${limit} de ${body.length} caracteres)` : ''}`
      : 'corpo vazio';

    this.logger.warn(
      `Resposta de ${operation} do emissor nacional fora do formato esperado — HTTP ${raw.status}, ${detail}`,
    );

    return `HTTP ${raw.status}, ${detail}`;
  }

  /**
   * Traduz a resposta do pedido de cancelamento. Só `200` e `201` contam como
   * registrado — pela mesma razão da emissão: dar a nota por cancelada sem
   * confirmação do fisco deixaria o sistema e o fisco discordando sobre um
   * documento fiscal, que é o pior desfecho possível.
   *
   * Os demais `2xx` **não** valem confirmação. `202 Accepted` diz exatamente que
   * o pedido foi enfileirado e ainda não avaliado, e um `204` de um gateway na
   * frente do emissor diria ainda menos. Tratar qualquer um dos dois como
   * registro marcaria a nota como cancelada enquanto o fisco a mantém válida.
   *
   * Ao contrário da emissão, não se exige identificador no corpo: o `Id` do
   * evento é conveniência de auditoria, e o código de resposta é a confirmação.
   */
  interpretCancelResponse(raw: NfseResponse): NfseCancelResult {
    const confirmed = raw.status === 200 || raw.status === 201;
    const inconclusive = !confirmed && raw.status >= 200 && raw.status < 300;

    let payload: Record<string, unknown> = {};

    try {
      payload = JSON.parse(raw.body) as Record<string, unknown>;
    } catch {
      // Corpo ilegível não muda o desfecho: quem decide é o código.
      if (confirmed) {
        return { registered: true, raw };
      }

      const detail = this.describeUnexpectedBody('cancelamento', raw);

      return {
        registered: false,
        message: inconclusive
          ? `Emissor nacional respondeu ${raw.status} sem confirmar o registro do evento — ${detail}`
          : `Resposta do emissor nacional em formato inesperado — ${detail}`,
        raw,
      };
    }

    if (confirmed) {
      return {
        registered: true,
        eventId: this.firstString(payload, ['idEvento', 'id', 'chaveEvento']),
        raw,
      };
    }

    const rejection = this.extractRejection(payload);

    return {
      registered: false,
      code: rejection.code,
      message:
        rejection.message ??
        (inconclusive
          ? `Emissor nacional respondeu ${raw.status} sem confirmar o registro do evento`
          : `Emissor nacional respondeu ${raw.status}`),
      raw,
    };
  }

  /**
   * Traduz a resposta de emissão. Só `2xx` com chave de acesso conta como
   * autorizada — na dúvida o resultado é recusa, porque marcar nota como emitida
   * sem confirmação do fisco é o pior erro possível aqui.
   */
  interpretIssueResponse(raw: NfseResponse): NfseIssueResult {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(raw.body) as Record<string, unknown>;
    } catch {
      // Resposta não-JSON: trata como recusa e registra status e corpo.
      return {
        authorized: false,
        message: `Resposta do emissor nacional em formato inesperado — ${this.describeUnexpectedBody('emissão', raw)}`,
        raw,
      };
    }

    const accessKey =
      (payload.chaveAcesso as string | undefined) ?? (payload.chave as string | undefined);

    if (raw.status >= 200 && raw.status < 300 && accessKey) {
      return {
        authorized: true,
        accessKey,
        nfseXml: this.decodeNfseXml(payload),
        raw,
      };
    }

    const rejection = this.extractRejection(payload);

    return {
      authorized: false,
      code: rejection.code,
      message: rejection.message ?? `Emissor nacional respondeu ${raw.status}`,
      raw,
    };
  }

  /**
   * Motivo da recusa. O emissor real devolve `erros: [{ Codigo, Descricao }]`,
   * com chaves capitalizadas e em lista; o formato plano (`codigo`/`mensagem`)
   * fica como segunda leitura. Sem isso, a rejeição fiscal chega ao Histórico
   * da nota só como "respondeu 400" e o operador não sabe o que corrigir.
   *
   * Todos os erros entram na mensagem, separados por `;`, e ela é limitada para
   * caber na coluna `message` do evento (1000 caracteres).
   */
  private extractRejection(payload: Record<string, unknown>): {
    code?: string;
    message?: string;
  } {
    const list = payload.erros ?? payload.Erros ?? payload.erro ?? payload.Erro;
    const entries = (Array.isArray(list) ? list : list ? [list] : []).filter(
      (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object',
    );

    const described = entries
      .map((entry) => {
        const code = this.firstStringIgnoringCase(entry, ['codigo', 'code']);
        const description = this.firstStringIgnoringCase(entry, [
          'descricao',
          'mensagem',
          'message',
        ]);
        const complement = this.firstStringIgnoringCase(entry, ['complemento']);
        const text = [description, complement].filter(Boolean).join(' — ');

        return { code, text: code && text ? `${code}: ${text}` : text || code };
      })
      .filter((item) => item.text);

    if (described.length > 0) {
      return {
        code: described[0].code,
        message: described
          .map((item) => item.text)
          .join('; ')
          .slice(0, NfseNationalClient.REJECTION_MESSAGE_LIMIT),
      };
    }

    return {
      code: this.firstString(payload, ['codigo', 'code', 'codigoErro']),
      message: this.firstString(payload, ['mensagem', 'message', 'descricao']),
    };
  }

  /**
   * Como `firstString`, mas comparando a chave sem diferenciar maiúsculas: o
   * emissor real devolve `Codigo`/`Descricao`. A ordem de `keys` é a ordem de
   * prioridade — não a ordem em que o payload declara as chaves — porque
   * `descricao` é a leitura primária e `mensagem`/`message` é só a segunda
   * leitura (ver `extractRejection`).
   */
  private firstStringIgnoringCase(
    payload: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    const byLowerCaseKey = new Map(
      Object.entries(payload).map(([key, value]) => [key.toLowerCase(), value]),
    );

    for (const key of keys) {
      const value = byLowerCaseKey.get(key.toLowerCase());
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return undefined;
  }

  private firstString(payload: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return undefined;
  }

  /**
   * O XML da nota vem em GZip mais base64. Falha de descompactação não invalida
   * a autorização: a chave de acesso já é a prova, e o XML pode ser rebuscado
   * depois por `GET /nfse/{chave}`.
   */
  private decodeNfseXml(payload: Record<string, unknown>): string | undefined {
    const encoded =
      (payload.nfseXmlGZipB64 as string | undefined) ?? (payload.nfseXml as string | undefined);

    if (!encoded) {
      return undefined;
    }

    const buffer = Buffer.from(encoded, 'base64');

    try {
      return gunzipSync(buffer, { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8');
    } catch {
      // Pode não estar comprimido; tenta como texto puro antes de desistir.
      const text = buffer.toString('utf8');
      return text.includes('<') ? text : undefined;
    }
  }

  /** Consulta o XML autorizado pela chave fiscal, também usada na reconciliação. */
  async getInvoice(params: {
    accessKey: string;
    credentials: NfseClientCredentials;
  }): Promise<NfseIssueResult> {
    const raw = await this.requestWithCertificate({
      method: 'GET',
      path: `/nfse/${params.accessKey}`,
      credentials: params.credentials,
    });
    if (raw.status !== 200) throw new Error('Consulta de NFS-e sem confirmação');
    const payload = JSON.parse(raw.body) as Record<string, unknown>;
    const key = payload.chaveAcesso ?? payload.chave ?? params.accessKey;
    const nfseXml = this.decodeNfseXml(payload);
    if (key !== params.accessKey || !nfseXml || !nfseXml.includes(params.accessKey))
      throw new Error('Consulta de NFS-e devolveu documento inesperado');
    return { authorized: true, accessKey: params.accessKey, nfseXml, raw };
  }

  /** Consulta específica do evento 101101, sequencial 1, antes de repetir. */
  async findCancellation(params: {
    accessKey: string;
    credentials: NfseClientCredentials;
  }): Promise<{ exists: boolean; eventXml?: string }> {
    const raw = await this.requestWithCertificate({
      method: 'GET',
      path: `/nfse/${params.accessKey}/eventos/101101/1`,
      credentials: params.credentials,
    });
    if (raw.status === 404) return { exists: false };
    if (raw.status !== 200) throw new Error('Consulta de cancelamento indeterminada');
    const payload = JSON.parse(raw.body) as Record<string, unknown>;
    const events = Array.isArray(payload.eventos) ? payload.eventos : [payload];
    for (const item of events) {
      const event = item as Record<string, unknown>;
      const encoded = event.eventoXmlGZipB64 ?? event.arquivoXml;
      if (typeof encoded !== 'string') continue;
      let buffer = Buffer.from(encoded, 'base64');
      if (!buffer.includes(Buffer.from('<')) && buffer[0] !== 0x1f)
        buffer = Buffer.from(buffer.toString('utf8'), 'base64');
      const xml =
        buffer[0] === 0x1f
          ? gunzipSync(buffer, { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8')
          : buffer.toString('utf8');
      if (xml.includes('e101101') && xml.includes(params.accessKey))
        return { exists: true, eventXml: xml };
    }
    throw new Error('Consulta de cancelamento sem documento confirmatório');
  }

  /**
   * Idempotência: pergunta ao fisco se a DPS já virou nota, antes de reenviar.
   * É o que impede nota duplicada quando a transmissão anterior falhou por
   * comunicação e não se sabe se chegou.
   *
   * `dpsId` são os 42 dígitos, sem o prefixo `DPS`.
   */
  async findExistingByDpsId(params: {
    dpsId: string;
    credentials: NfseClientCredentials;
    baseUrlOverride?: {
      host: string;
      port: number;
      rejectUnauthorized?: boolean;
    };
  }): Promise<{ exists: boolean; accessKey?: string }> {
    const raw = await this.requestWithCertificate({
      method: 'GET',
      path: `/dps/${params.dpsId}`,
      credentials: params.credentials,
      baseUrlOverride: params.baseUrlOverride,
    });

    if (raw.status === 404) {
      return { exists: false };
    }

    if (raw.status < 200 || raw.status >= 300) {
      // Indeterminado não é "não existe": deixar seguir para reenvio poderia
      // duplicar a nota, então o chamador precisa tratar como falha técnica.
      throw new Error(`Consulta de DPS respondeu ${raw.status} — situação indeterminada`);
    }

    try {
      const payload = JSON.parse(raw.body) as Record<string, unknown>;
      const accessKey =
        (payload.chaveAcesso as string | undefined) ?? (payload.chave as string | undefined);
      if (!accessKey) throw new Error('Consulta de DPS sem chave — situação indeterminada');
      return { exists: true, accessKey };
    } catch {
      throw new Error('Consulta de DPS devolveu corpo inesperado — situação indeterminada');
    }
  }
}
