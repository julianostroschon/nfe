import 'reflect-metadata';
import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { getQueueToken } from '@nestjs/bull';
import type { Queue } from 'bull';
import { createApplication } from '../src/main';
import { PrismaService } from '../src/database/prisma.service';
import { createTestPkcs12 } from '../src/certificates/tests/pkcs12.fixture';
import { NfseSimulatorHandle, startNfseSimulator } from '../src/core/nfse-national.simulator';
import { webhookSignature } from '../src/jobs/webhook';
import { QUEUE_NAME, TaskDispatcher } from '../src/jobs/tasks.worker';

const CNPJ = '12345678000195';
const OTHER = '98765432000198';
const apiKey = randomBytes(32).toString('hex');
const secret = randomBytes(32).toString('hex');
const suffix = randomBytes(8).toString('hex');
const cityCode = 4314902;
const rejectedCodes: string[] = [];
const body = {
  externalId: 'externo-' + suffix,
  environment: 'HOMOLOGATION',
  issuer: {
    cnpj: CNPJ,
    name: 'Empresa Sintética LTDA',
    cityCode,
    simplesNacional: '1',
    specialTaxRegime: '0',
  },
  taker: { cnpj: OTHER, name: 'Tomador Sintético LTDA' },
  serviceCityCode: cityCode,
  competency: '2026-10-01',
  service: {
    lc116Code: '01.01',
    nationalServiceCode: '010101',
    municipalTaxCode: '001',
    description: 'Serviço técnico genérico',
    issqnTaxation: '1',
    issRate: '2.00',
    issWithheld: false,
  },
  values: {
    amount: '1500.00',
    totalFederalTaxPercent: '1.25',
    totalStateTaxPercent: '0.00',
    totalMunicipalTaxPercent: '2.00',
  },
};

describe('API → MySQL → Redis → mTLS → webhook HMAC', () => {
  let app: INestApplication;
  let db: PrismaService;
  let simulator: NfseSimulatorHandle;
  let receiver: Server;
  let configId: string;
  const hooks: Array<{
    headers: Record<string, unknown>;
    raw: string;
    payload: Record<string, any>;
  }> = [];
  let rejectFirstWebhook = true;
  function api(method: 'post' | 'get' | 'patch' | 'delete', path: string, cnpj = CNPJ) {
    return request(app.getHttpServer())
      [method](path)
      .set('X-API-Key', apiKey)
      .set('X-Emitter-Cnpj', cnpj);
  }
  async function until(predicate: () => Promise<boolean> | boolean, description: string) {
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Tempo esgotado: ' + description);
  }
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.API_KEY_HASHES_JSON = JSON.stringify([
      { sha256: createHash('sha256').update(apiKey).digest('hex'), cnpjs: [CNPJ, OTHER] },
    ]);
    simulator = await startNfseSimulator({
      port: 0,
      quiet: true,
      failAfterIssueOnce: true,
      failAfterCancelOnce: true,
      reject: rejectedCodes,
    });
    process.env.NFSE_BASE_URL_OVERRIDE = `${simulator.host}:${simulator.port}`;
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        hooks.push({ headers: req.headers, raw, payload: JSON.parse(raw) });
        res.writeHead(rejectFirstWebhook ? 503 : 204);
        rejectFirstWebhook = false;
        res.end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    app = (await createApplication()).app;
    await app.init();
    db = app.get(PrismaService);
    const port = (receiver.address() as { port: number }).port;
    // Só o cadastro de teste deste emitente/ambiente é substituído; notas são preservadas.
    await db.fiscalCityConfig.deleteMany({
      where: { cnpj: CNPJ, cityCode, environment: 'HOMOLOGATION' },
    });
    const config = await api('post', '/city-configs')
      .send({
        cityCode,
        environment: 'HOMOLOGATION',
        enabled: true,
        series: '1',
        webhookUrl: `http://127.0.0.1:${port}/events`,
        webhookSecret: secret,
      })
      .expect(201);
    configId = config.body.id;
    const pfx = createTestPkcs12({
      password: 'teste123',
      cnpj: CNPJ,
      companyName: 'EMPRESA SINTETICA',
    });
    await api('post', '/certificates')
      .send({ pfxBase64: pfx.toString('base64'), password: 'teste123' })
      .expect(201);
  });
  afterAll(async () => {
    if (db && configId) await db.fiscalCityConfig.deleteMany({ where: { id: configId } });
    await app?.close();
    await simulator?.close();
    if (receiver) await new Promise<void>((resolve) => receiver.close(() => resolve()));
  });
  it('protege API, valida contrato, emite, consulta e cancela com eventos assinados', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/certificates').expect(401);
    await api('get', '/certificates', '11111111000111').expect(403);
    await api('post', '/invoices').send(body).expect(400);
    await api('post', '/invoices')
      .set('Idempotency-Key', 'invalid-' + suffix)
      .send({ ...body, unexpected: true })
      .expect(400);
    await api('post', '/invoices')
      .set('Idempotency-Key', 'invalid-' + suffix)
      .send({ ...body, values: { ...body.values, amount: '0.00' } })
      .expect(400);
    const wrongPfx = createTestPkcs12({ password: 'teste123', cnpj: OTHER });
    await api('post', '/certificates')
      .send({ pfxBase64: wrongPfx.toString('base64'), password: 'teste123' })
      .expect(400);
    const certs = await api('get', '/certificates').expect(200);
    expect(JSON.stringify(certs.body)).not.toMatch(/fileCipher|passwordCipher|pfxBase64|teste123/);
    const configs = await api('get', '/city-configs').expect(200);
    expect(JSON.stringify(configs.body)).not.toContain(secret);
    const key = 'emit-' + suffix;
    const [first, second] = await Promise.all([
      api('post', '/invoices').set('Idempotency-Key', key).send(body).expect(202),
      api('post', '/invoices').set('Idempotency-Key', key).send(body).expect(202),
    ]);
    expect(first.body.id).toBe(second.body.id);
    const id = first.body.id;
    await api('post', '/invoices')
      .set('Idempotency-Key', key)
      .send({ ...body, values: { ...body.values, amount: '1600.00' } })
      .expect(409);
    await api('get', `/invoices/${id}`, OTHER).expect(404);
    await api('post', `/invoices/${id}/cancel`, OTHER)
      .set('Idempotency-Key', 'cancel')
      .send({ reasonCode: '1', reason: 'Dados fiscais incorretos no pedido' })
      .expect(404);
    await until(
      async () => (await api('get', `/invoices/${id}`)).body.status === 'AUTHORIZED',
      'autorização',
    );
    await until(
      async () =>
        hooks.filter((h) => h.payload.invoiceId === id && h.payload.type === 'invoice.authorized')
          .length >= 2 &&
        (await db.fiscalTask.count({ where: { invoiceId: id, kind: 'WEBHOOK', status: 'DONE' } })) >
          0,
      'reentrega do webhook',
    );
    expect(simulator.issued.size).toBe(1);
    expect((await api('get', `/invoices/${id}`)).body.attemptCount).toBeGreaterThanOrEqual(2);
    const signed = (await db.fiscalInvoice.findUniqueOrThrow({ where: { id } })).signedDpsXml;
    expect(signed).toContain('<cTribMun>001</cTribMun>');
    expect(signed).toContain('<pTotTribFed>1.25</pTotTribFed>');
    const emitted = await api('get', `/invoices/${id}`).expect(200);
    expect(emitted.body.authorizedXml).toContain('<NFSe');
    expect(
      (await api('get', `/invoices/${id}?refresh=true`).expect(200)).body.national.canceled,
    ).toBe(false);
    const deliveries = hooks.filter(
      (h) => h.payload.invoiceId === id && h.payload.type === 'invoice.authorized',
    );
    expect(deliveries[0].payload.eventId).toBe(deliveries[1].payload.eventId);
    for (const hook of deliveries) {
      expect(hook.headers['x-webhook-signature']).toBe(
        'sha256=' + webhookSignature(secret, String(hook.headers['x-webhook-timestamp']), hook.raw),
      );
      expect(hook.payload.externalId).toBe(body.externalId);
      expect(hook.raw).not.toContain(secret);
    }
    const cancel = { reasonCode: '1', reason: 'Dados fiscais incorretos no pedido original' };
    const cancelKey = 'cancel-' + suffix;
    await api('post', `/invoices/${id}/cancel`)
      .set('Idempotency-Key', cancelKey)
      .send(cancel)
      .expect(202);
    await api('post', `/invoices/${id}/cancel`)
      .set('Idempotency-Key', cancelKey)
      .send(cancel)
      .expect(202);
    await api('post', `/invoices/${id}/cancel`)
      .set('Idempotency-Key', cancelKey)
      .send({ ...cancel, reasonCode: '9' })
      .expect(409);
    await until(
      async () => (await api('get', `/invoices/${id}`)).body.status === 'CANCELED',
      'cancelamento',
    );
    await until(
      () => hooks.some((h) => h.payload.invoiceId === id && h.payload.type === 'invoice.canceled'),
      'webhook de cancelamento',
    );
    expect(simulator.canceled.size).toBe(1);
    expect(
      (await api('get', `/invoices/${id}?refresh=true`).expect(200)).body.national.canceled,
    ).toBe(true);
    expect((await api('get', `/invoices/${id}`)).body.authorizedXml).toBe(
      emitted.body.authorizedXml,
    );
    await api('get', '/docs-json').expect(200);
  });
  it('reserva numeração única para pedidos concorrentes', async () => {
    const calls = Array.from({ length: 5 }, (_, n) =>
      api('post', '/invoices')
        .set('Idempotency-Key', `parallel-${suffix}-${n}`)
        .send({ ...body, externalId: `parallel-${suffix}-${n}` })
        .expect(202),
    );
    const results = await Promise.all(calls);
    const numbers = results.map((r) => r.body.number);
    expect(new Set(numbers).size).toBe(5);
    expect(Math.max(...numbers) - Math.min(...numbers)).toBe(4);
    expect(new Set(results.map((r) => r.body.dpsId)).size).toBe(5);
    await app.get(TaskDispatcher).tick();
    await until(
      async () =>
        (await db.fiscalInvoice.count({
          where: { id: { in: results.map((r) => r.body.id) }, status: 'AUTHORIZED' },
        })) === 5,
      'emissões concorrentes',
    );
  });
  it('persiste intenção enquanto o worker está pausado e processa ao retomar', async () => {
    const queue = app.get<Queue>(getQueueToken(QUEUE_NAME));
    await queue.pause(true);
    let id = '';
    try {
      const result = await api('post', '/invoices')
        .set('Idempotency-Key', 'paused-' + suffix)
        .send({ ...body, externalId: 'paused-' + suffix })
        .expect(202);
      id = result.body.id;
      expect(
        await db.fiscalTask.count({ where: { invoiceId: id, kind: 'ISSUE', status: 'PENDING' } }),
      ).toBe(1);
      expect((await api('get', `/invoices/${id}`)).body.status).toBe('PENDING');
      await app.get(TaskDispatcher).tick();
      expect((await api('get', `/invoices/${id}`)).body.status).toBe('PENDING');
    } finally {
      await queue.resume(true);
    }
    await until(
      async () => (await api('get', `/invoices/${id}`)).body.status === 'AUTHORIZED',
      'retomada do processamento',
    );
  });
  it('registra rejeição fiscal confirmada e entrega webhook sem retransmitir', async () => {
    rejectedCodes.push('1.01');
    const result = await api('post', '/invoices')
      .set('Idempotency-Key', 'rejected-' + suffix)
      .send({ ...body, externalId: 'rejected-' + suffix })
      .expect(202);
    const id = result.body.id;
    await until(
      async () => (await api('get', `/invoices/${id}`)).body.status === 'REJECTED',
      'rejeição confirmada',
    );
    await until(
      () => hooks.some((h) => h.payload.invoiceId === id && h.payload.type === 'invoice.rejected'),
      'webhook de rejeição',
    );
    const row = (await api('get', `/invoices/${id}`)).body;
    expect(row.authorizedXml).toBeNull();
    expect(row.attemptCount).toBe(1);
    expect(hooks.find((h) => h.payload.invoiceId === id)?.payload.result.code).toBe('9999');
    await api('post', `/invoices/${id}/cancel`)
      .set('Idempotency-Key', 'cancel-rejected-' + suffix)
      .send({ reasonCode: '9', reason: 'Pedido recusado não admite cancelamento' })
      .expect(409);
    rejectedCodes.length = 0;
  });
  it('distingue chaves de idempotência que diferem apenas por maiúsculas', async () => {
    const key = 'case-' + suffix;
    const first = await api('post', '/invoices').set('Idempotency-Key', key).send(body).expect(202);
    const second = await api('post', '/invoices')
      .set('Idempotency-Key', key.toUpperCase())
      .send(body)
      .expect(202);
    expect(first.body.id).not.toBe(second.body.id);
    await until(
      async () =>
        (await db.fiscalInvoice.count({
          where: { id: { in: [first.body.id, second.body.id] }, status: 'AUTHORIZED' },
        })) === 2,
      'idempotência com comparação binária',
    );
  });
});
