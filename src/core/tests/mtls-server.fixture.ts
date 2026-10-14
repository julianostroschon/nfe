import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import * as forge from 'node-forge';

/**
 * Servidor HTTPS com mTLS, levantado no próprio teste.
 *
 * Existe porque o ambiente de homologação do fisco exige certificado ICP-Brasil
 * real e credenciamento, que não temos. Sem isto, o transporte só seria
 * exercitado com o cliente HTTP inteiro mockado — o que não prova que o
 * handshake mTLS funciona, e handshake é justamente onde a integração falha
 * primeiro.
 *
 * Aqui o servidor **exige** certificado de cliente e devolve o que o cliente
 * apresentou, então o teste consegue afirmar que o `.pfx` chegou ao outro lado.
 */

export interface MtlsServerHandle {
  host: string;
  port: number;
  /** Requisições recebidas, na ordem. */
  received: Array<{
    method: string;
    url: string;
    body: string;
    /** CN do certificado que o cliente apresentou, ou undefined se não veio. */
    clientCertificateSubject?: string;
  }>;
  close: () => Promise<void>;
}

export interface MtlsServerOptions {
  /** Resposta por rota. A chave é `MÉTODO caminho`, ex.: `POST /nfse`. */
  routes: Record<string, { status: number; body: string }>;
}

/** Par autoassinado para o servidor de teste. 2048 bits: compatível com OpenSSL do Node 22. */
function createSelfSignedPair(commonName: string): {
  keyPem: string;
  certPem: string;
} {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const attrs = [{ name: 'commonName', value: commonName }];
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

export async function startMtlsServer(options: MtlsServerOptions): Promise<MtlsServerHandle> {
  const { keyPem, certPem } = createSelfSignedPair('localhost');
  const received: MtlsServerHandle['received'] = [];

  const server: Server = createServer(
    {
      key: keyPem,
      cert: certPem,
      // Exige certificado do cliente, mas não valida a cadeia: o `.pfx` de teste
      // é autoassinado e o que interessa é provar que ele foi apresentado.
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

        received.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          clientCertificateSubject: peer?.subject?.CN,
        });

        const route = options.routes[`${req.method} ${req.url}`];
        if (!route) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ mensagem: 'rota não configurada no teste' }));
          return;
        }

        res.writeHead(route.status, { 'Content-Type': 'application/json' });
        res.end(route.body);
      });
    },
  );

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    host: '127.0.0.1',
    port,
    received,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
