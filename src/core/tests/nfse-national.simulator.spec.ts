import type { ConfigService } from '@nestjs/config';
import { createTestPkcs12 } from '../../certificates/tests/pkcs12.fixture';
import { buildDps, DPS_ENVIRONMENT, type DpsFiscalClassification } from '../dps.builder';
import { extractSigningMaterial, signCancellationEvent, signDps } from '../dps.signer';
import {
  buildCancellationEvent,
  CANCELLATION_REASON_CODE,
  type CancellationReasonCode,
  EVENT_ENVIRONMENT,
} from '../cancellation-event.builder';
import { NfseNationalClient } from '../nfse-national.client';
import { type NfseSimulatorHandle, startNfseSimulator } from '../nfse-national.simulator';

/**
 * O simulador do Emissor Nacional exercitado pelo **cliente real**, ponta a
 * ponta: monta a DPS, assina, compacta, transmite sobre mTLS e interpreta a
 * resposta.
 *
 * É o teste que dá valor ao simulador. Um simulador escrito à mão e verificado à
 * mão só serve enquanto alguém lembra de rodar; aqui a suíte garante que o
 * ambiente de teste continua parecido com o fisco — e, quando o simulador
 * recusa, que o cliente entende a recusa em vez de inventar autorização.
 */

const PASSWORD = 'teste123';
const PROVIDER_CNPJ = '12345678000195';
const PORTO_ALEGRE = 4314902;

const SERVICE_A: DpsFiscalClassification = {
  nationalServiceCode: '040205',
  simplesNacional: '1',
  specialTaxRegime: '0',
  issqnTaxation: '1',
};

const SERVICE_B: DpsFiscalClassification = {
  ...SERVICE_A,
  nationalServiceCode: '040101',
};

function clientFor(simulator: NfseSimulatorHandle): NfseNationalClient {
  // Aponta o cliente ao simulador pela variável de ambiente, e não pelo
  // parâmetro de teste: é o mesmo caminho que o ambiente de desenvolvimento usa,
  // então o teste cobre a configuração além do transporte.
  return new NfseNationalClient({
    get: (key: string) =>
      key === 'NFSE_BASE_URL_OVERRIDE' ? `${simulator.host}:${simulator.port}` : undefined,
  } as unknown as ConfigService);
}

function signedDpsFor(
  pfx: Buffer,
  options: { number: number; fiscal: DpsFiscalClassification },
): string {
  const built = buildDps({
    environment: DPS_ENVIRONMENT.HOMOLOGATION,
    issuedAt: new Date('2026-08-20T14:30:00Z'),
    applicationVersion: 'FiscalService',
    series: '1',
    number: options.number,
    competency: new Date('2026-08-01T00:00:00Z'),
    issuerCityCode: PORTO_ALEGRE,
    serviceCityCode: PORTO_ALEGRE,
    provider: { cnpj: PROVIDER_CNPJ, name: 'Empresa Sintética Teste LTDA' },
    taker: { cnpj: '98765432000198', name: 'Operadora Exemplo LTDA' },
    serviceDescription: 'Serviços técnicos genéricos',
    amount: '1500.00',
    issRate: '2.00',
    issWithheld: false,
    fiscal: options.fiscal,
  });

  return signDps({
    xml: built.xml,
    idAttribute: built.idAttribute,
    material: extractSigningMaterial(pfx, PASSWORD),
  });
}

const CANCELLATION_REASON = 'Nota emitida para o tomador errado no fechamento do lote';

function signedCancellationFor(
  pfx: Buffer,
  options: { accessKey: string; reasonCode?: CancellationReasonCode },
): string {
  const built = buildCancellationEvent({
    environment: EVENT_ENVIRONMENT.HOMOLOGATION,
    requestedAt: new Date('2026-08-25T10:00:00Z'),
    applicationVersion: 'FiscalService',
    authorCnpj: PROVIDER_CNPJ,
    accessKey: options.accessKey,
    reasonCode: options.reasonCode ?? CANCELLATION_REASON_CODE.ISSUE_ERROR,
    reason: CANCELLATION_REASON,
  });

  return signCancellationEvent({
    xml: built.xml,
    idAttribute: built.idAttribute,
    material: extractSigningMaterial(pfx, PASSWORD),
  });
}

describe('simulador do Emissor Nacional', () => {
  let pfx: Buffer;
  let simulator: NfseSimulatorHandle;

  beforeAll(() => {
    pfx = createTestPkcs12({ password: PASSWORD, cnpj: PROVIDER_CNPJ });
  });

  afterEach(async () => {
    await simulator?.close();
  });

  describe('emissão ponta a ponta contra o simulador', () => {
    it('autoriza a DPS assinada e devolve chave de acesso e XML da nota', async () => {
      simulator = await startNfseSimulator({ port: 0, quiet: true });

      const result = await clientFor(simulator).issue({
        signedDpsXml: signedDpsFor(pfx, { number: 1, fiscal: SERVICE_A }),
        credentials: { pfx, passphrase: PASSWORD },
      });

      expect(result.authorized).toBe(true);
      expect(result.accessKey).toMatch(/^\d{50}$/);
      expect(result.nfseXml).toContain('<chNFSe>');
      expect(simulator.issued.size).toBe(1);
    });

    /**
     * O handshake é a metade do transporte que mock nenhum prova. O simulador
     * exige certificado de cliente, então autorização aqui significa que o
     * `.pfx` chegou ao outro lado.
     */
    it('só autoriza porque o certificado de cliente foi apresentado no handshake', async () => {
      simulator = await startNfseSimulator({ port: 0, quiet: true });

      const result = await clientFor(simulator).issue({
        signedDpsXml: signedDpsFor(pfx, { number: 2, fiscal: SERVICE_A }),
        credentials: { pfx, passphrase: PASSWORD },
      });

      expect(result.authorized).toBe(true);
    });

    it('emite dois itens fiscais diferentes como notas independentes', async () => {
      simulator = await startNfseSimulator({ port: 0, quiet: true });
      const client = clientFor(simulator);

      const serviceA = await client.issue({
        signedDpsXml: signedDpsFor(pfx, { number: 10, fiscal: SERVICE_A }),
        credentials: { pfx, passphrase: PASSWORD },
      });
      const serviceB = await client.issue({
        signedDpsXml: signedDpsFor(pfx, { number: 11, fiscal: SERVICE_B }),
        credentials: { pfx, passphrase: PASSWORD },
      });

      expect(serviceA.authorized).toBe(true);
      expect(serviceB.authorized).toBe(true);
      expect(serviceA.accessKey).not.toBe(serviceB.accessKey);
    });
  });

  describe('o simulador recusa o que o fisco recusaria', () => {
    it('recusa DPS sem assinatura com o código 2104', async () => {
      simulator = await startNfseSimulator({ port: 0, quiet: true });

      const built = buildDps({
        environment: DPS_ENVIRONMENT.HOMOLOGATION,
        issuedAt: new Date('2026-08-20T14:30:00Z'),
        applicationVersion: 'FiscalService',
        series: '1',
        number: 20,
        competency: new Date('2026-08-01T00:00:00Z'),
        issuerCityCode: PORTO_ALEGRE,
        serviceCityCode: PORTO_ALEGRE,
        provider: { cnpj: PROVIDER_CNPJ },
        serviceDescription: 'Sem assinatura',
        amount: '100.00',
        issRate: '2.00',
        issWithheld: false,
        fiscal: SERVICE_A,
      });

      const result = await clientFor(simulator).issue({
        signedDpsXml: built.xml,
        credentials: { pfx, passphrase: PASSWORD },
      });

      expect(result.authorized).toBe(false);
      expect(result.code).toBe('2104');
    });

    it('recusa XML que não é DPS, em vez de autorizar qualquer coisa', async () => {
      simulator = await startNfseSimulator({ port: 0, quiet: true });

      const result = await clientFor(simulator).issue({
        signedDpsXml: '<qualquerCoisa><Signature/></qualquerCoisa>',
        credentials: { pfx, passphrase: PASSWORD },
      });

      expect(result.authorized).toBe(false);
    });

    it('recusa o item configurado para rejeição, sem afetar os demais', async () => {
      simulator = await startNfseSimulator({
        port: 0,
        quiet: true,
        reject: ['4.01'],
      });
      const client = clientFor(simulator);

      const serviceB = await client.issue({
        signedDpsXml: signedDpsFor(pfx, { number: 30, fiscal: SERVICE_B }),
        credentials: { pfx, passphrase: PASSWORD },
      });
      const serviceA = await client.issue({
        signedDpsXml: signedDpsFor(pfx, { number: 31, fiscal: SERVICE_A }),
        credentials: { pfx, passphrase: PASSWORD },
      });

      expect(serviceB.authorized).toBe(false);
      expect(serviceB.message).toContain('4.01');
      expect(serviceA.authorized).toBe(true);
    });
  });

  describe('cancelamento ponta a ponta contra o simulador', () => {
    /** Emite uma nota e devolve a chave, que é o insumo do cancelamento. */
    async function issueAndGetKey(
      simulatorHandle: NfseSimulatorHandle,
      number: number,
    ): Promise<string> {
      const result = await clientFor(simulatorHandle).issue({
        signedDpsXml: signedDpsFor(pfx, { number, fiscal: SERVICE_A }),
        credentials: { pfx, passphrase: PASSWORD },
      });

      return result.accessKey as string;
    }

    it('registra o cancelamento da nota emitida, com o motivo declarado', async () => {
      simulator = await startNfseSimulator({ port: 0, quiet: true });
      const accessKey = await issueAndGetKey(simulator, 60);

      const result = await clientFor(simulator).cancel({
        accessKey,
        signedEventXml: signedCancellationFor(pfx, { accessKey }),
        credentials: { pfx, passphrase: PASSWORD },
      });

      expect(result.registered).toBe(true);
      expect(simulator.canceled.get(accessKey)).toEqual({
        reasonCode: CANCELLATION_REASON_CODE.ISSUE_ERROR,
        reason: CANCELLATION_REASON,
      });
    });

    it('recusa pedido sem assinatura com o código 2104', async () => {
      simulator = await startNfseSimulator({ port: 0, quiet: true });
      const accessKey = await issueAndGetKey(simulator, 61);

      const { xml } = buildCancellationEvent({
        environment: EVENT_ENVIRONMENT.HOMOLOGATION,
        requestedAt: new Date('2026-08-25T10:00:00Z'),
        applicationVersion: 'FiscalService',
        authorCnpj: PROVIDER_CNPJ,
        accessKey,
        reasonCode: CANCELLATION_REASON_CODE.ISSUE_ERROR,
        reason: CANCELLATION_REASON,
      });

      const result = await clientFor(simulator).cancel({
        accessKey,
        signedEventXml: xml,
        credentials: { pfx, passphrase: PASSWORD },
      });

      expect(result.registered).toBe(false);
      expect(result.code).toBe('2104');
      expect(simulator.canceled.size).toBe(0);
    });

    it('recusa cancelar nota que ele não emitiu', async () => {
      simulator = await startNfseSimulator({ port: 0, quiet: true });
      const accessKey = '9'.repeat(50);

      const result = await clientFor(simulator).cancel({
        accessKey,
        signedEventXml: signedCancellationFor(pfx, { accessKey }),
        credentials: { pfx, passphrase: PASSWORD },
      });

      expect(result.registered).toBe(false);
      expect(result.code).toBe('404');
    });

    /**
     * Cancelar duas vezes é o erro que o reenvio de uma requisição produz. O
     * fisco recusa, e é o simulador quem precisa provar que o sistema entende
     * essa recusa em vez de marcar a nota de novo.
     */
    it('recusa o segundo cancelamento da mesma nota', async () => {
      simulator = await startNfseSimulator({ port: 0, quiet: true });
      const accessKey = await issueAndGetKey(simulator, 62);
      const client = clientFor(simulator);
      const signed = signedCancellationFor(pfx, { accessKey });

      const first = await client.cancel({
        accessKey,
        signedEventXml: signed,
        credentials: { pfx, passphrase: PASSWORD },
      });
      const second = await client.cancel({
        accessKey,
        signedEventXml: signed,
        credentials: { pfx, passphrase: PASSWORD },
      });

      expect(first.registered).toBe(true);
      expect(second.registered).toBe(false);
      expect(second.code).toBe('2301');
    });

    it('recusa pedido cuja chave declarada não é a da nota informada', async () => {
      simulator = await startNfseSimulator({ port: 0, quiet: true });
      const accessKey = await issueAndGetKey(simulator, 63);
      const otherKey = '8'.repeat(50);

      const result = await clientFor(simulator).cancel({
        accessKey,
        signedEventXml: signedCancellationFor(pfx, { accessKey: otherKey }),
        credentials: { pfx, passphrase: PASSWORD },
      });

      expect(result.registered).toBe(false);
      expect(result.code).toBe('1003');
    });
  });

  describe('idempotência', () => {
    it('devolve a mesma nota quando a mesma DPS é transmitida de novo', async () => {
      simulator = await startNfseSimulator({ port: 0, quiet: true });
      const client = clientFor(simulator);
      const signed = signedDpsFor(pfx, { number: 40, fiscal: SERVICE_A });

      const first = await client.issue({
        signedDpsXml: signed,
        credentials: { pfx, passphrase: PASSWORD },
      });
      const second = await client.issue({
        signedDpsXml: signed,
        credentials: { pfx, passphrase: PASSWORD },
      });

      expect(second.accessKey).toBe(first.accessKey);
      expect(simulator.issued.size).toBe(1);
    });

    it('responde à consulta por DPS depois de emitir, e 404 antes', async () => {
      simulator = await startNfseSimulator({ port: 0, quiet: true });
      const client = clientFor(simulator);
      const credentials = { pfx, passphrase: PASSWORD };
      const signed = signedDpsFor(pfx, { number: 50, fiscal: SERVICE_A });
      const dpsId = /Id="DPS(\d{42})"/.exec(signed)?.[1] as string;

      const before = await client.findExistingByDpsId({ dpsId, credentials });
      expect(before.exists).toBe(false);

      await client.issue({ signedDpsXml: signed, credentials });

      const after = await client.findExistingByDpsId({ dpsId, credentials });
      expect(after.exists).toBe(true);
      expect(after.accessKey).toMatch(/^\d{50}$/);
    });
  });
});
