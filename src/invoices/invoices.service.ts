import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { NfseNationalClient } from '../core/nfse-national.client';
import { PrismaService } from '../database/prisma.service';
import { ConfigsService } from '../configs/configs.service';
import { DpsNumberingService } from '../core/dps-numbering.service';
import { buildDps } from '../core/dps.builder';
import { buildCancellationEvent } from '../core/cancellation-event.builder';
import { extractSigningMaterial, signCancellationEvent, signDps } from '../core/dps.signer';
import { PED_REG_EVENTO_SCHEMA, validateAgainstXsd } from '../core/xsd-validator';
import { CancelInvoiceDto, CreateInvoiceDto } from './invoice.dto';

/** Ordenação recursiva torna a chave independente da ordem dos campos JSON. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const requestHash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export function assertIdempotencyKey(key: string | undefined): asserts key is string {
  if (!key || !/^[\x21-\x7e]{1,200}$/.test(key))
    throw new BadRequestException(
      'Idempotency-Key obrigatório: 1 a 200 caracteres ASCII sem espaços',
    );
}
export function assertXsd(xml: string, schema?: string) {
  const result = validateAgainstXsd(xml, schema);
  if (!result.valid)
    throw new BadRequestException(
      'Documento fiscal não atende ao XSD: ' + result.errors.slice(0, 700),
    );
}
const PUBLIC_SELECT = {
  id: true,
  cnpj: true,
  environment: true,
  externalId: true,
  status: true,
  request: true,
  dpsId: true,
  series: true,
  number: true,
  accessKey: true,
  authorizedXml: true,
  authorizedAt: true,
  cancellationStatus: true,
  cancellationEventXml: true,
  lastError: true,
  attemptCount: true,
  createdAt: true,
  updatedAt: true,
  events: {
    select: { id: true, type: true, code: true, message: true, createdAt: true },
    orderBy: { createdAt: 'asc' as const },
  },
  tasks: {
    select: { id: true, kind: true, status: true, attempts: true, lastError: true },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.FiscalInvoiceSelect;

@Injectable()
export class InvoicesService {
  constructor(
    private readonly db: PrismaService,
    private readonly configs: ConfigsService,
    private readonly numbering: DpsNumberingService,
  ) {}
  async find(cnpj: string, id: string) {
    const row = await this.db.fiscalInvoice.findFirst({
      where: { id, cnpj },
      select: PUBLIC_SELECT,
    });
    if (!row) throw new NotFoundException('Pedido fiscal não encontrado');
    return row;
  }
  async consultNational(cnpj: string, id: string) {
    const local = await this.find(cnpj, id);
    const credentials = await this.configs.material(cnpj);
    const client = new NfseNationalClient(
      new ConfigService({
        NFSE_ENVIRONMENT: local.environment,
        NFSE_BASE_URL_OVERRIDE: process.env.NFSE_BASE_URL_OVERRIDE,
      }),
    );
    try {
      const found = await client.findExistingByDpsId({ dpsId: local.dpsId, credentials });
      if (!found.exists || !found.accessKey) return { ...local, national: { exists: false } };
      const result = await client.getInvoice({ accessKey: found.accessKey, credentials });
      const cancellation = await client.findCancellation({
        accessKey: found.accessKey,
        credentials,
      });
      return {
        ...local,
        national: {
          exists: true,
          accessKey: found.accessKey,
          authorizedXml: result.nfseXml,
          canceled: cancellation.exists,
          cancellationEventXml: cancellation.eventXml ?? null,
        },
      };
    } catch {
      throw new ServiceUnavailableException(
        'Consulta ao Emissor Nacional sem confirmação; estado local preservado',
      );
    }
  }
  async create(cnpj: string, dto: CreateInvoiceDto, key: string | undefined) {
    assertIdempotencyKey(key);
    if (dto.issuer.cnpj !== cnpj)
      throw new BadRequestException('Emitente deve corresponder ao contexto autorizado');
    if (dto.issuer.simplesNacional === '3' && !dto.issuer.simplesNacionalRegime)
      throw new BadRequestException('Regime de apuração do Simples obrigatório');
    if (dto.issuer.simplesNacional !== '3' && dto.issuer.simplesNacionalRegime)
      throw new BadRequestException('Regime de apuração só se aplica a ME/EPP');
    if (dto.service.nationalServiceCode.slice(0, 4) !== dto.service.lc116Code.replace('.', ''))
      throw new BadRequestException('Código nacional não corresponde ao item LC 116 declarado');
    if (
      Number(dto.values.amount) <= 0 ||
      Number(dto.service.issRate) > 5 ||
      [
        dto.values.totalFederalTaxPercent,
        dto.values.totalStateTaxPercent,
        dto.values.totalMunicipalTaxPercent,
      ].some((v) => Number(v) > 100)
    )
      throw new BadRequestException('Valor ou percentual fora do intervalo permitido');
    if (process.env.NFSE_BASE_URL_OVERRIDE && dto.environment === 'PRODUCTION')
      throw new BadRequestException('Override do emissor não permitido em produção');
    const hash = requestHash(dto);
    const where = {
      cnpj_environment_idempotencyKey: { cnpj, environment: dto.environment, idempotencyKey: key },
    };
    const existing = await this.db.fiscalInvoice.findUnique({ where });
    if (existing) {
      if (existing.requestHash !== hash)
        throw new ConflictException('Chave de idempotência já utilizada com outro conteúdo');
      return this.find(cnpj, existing.id);
    }
    const material = await this.configs.material(cnpj);
    const signing = extractSigningMaterial(material.pfx, material.passphrase);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const id = await this.db.$transaction(
          async (tx) => {
            const config = await tx.fiscalCityConfig.findUnique({
              where: {
                cnpj_cityCode_environment: {
                  cnpj,
                  cityCode: dto.issuer.cityCode,
                  environment: dto.environment,
                },
              },
            });
            if (!config?.enabled)
              throw new BadRequestException(
                'Emissão não habilitada para emitente, município e ambiente',
              );
            const certificate = await tx.fiscalCertificate.findFirst({
              where: { id: material.id, cnpj, status: { not: 'REVOKED' } },
            });
            if (!certificate)
              throw new BadRequestException('Certificado revogado durante preparação');
            // UPSERT e incremento na mesma transação: o MySQL serializa a reserva por chave.
            const number = await this.numbering.reserve(tx, cnpj, dto.environment, config.series);
            const issuedAt = new Date();
            const built = buildDps({
              environment: dto.environment === 'PRODUCTION' ? '1' : '2',
              issuedAt,
              applicationVersion: 'FiscalService 0.1',
              series: config.series,
              number,
              competency: new Date(dto.competency + 'T00:00:00Z'),
              issuerCityCode: dto.issuer.cityCode,
              serviceCityCode: dto.serviceCityCode,
              provider: dto.issuer,
              taker: dto.taker,
              serviceDescription: dto.service.description,
              amount: dto.values.amount,
              issRate: dto.service.issRate,
              issWithheld: dto.service.issWithheld,
              fiscal: { ...dto.issuer, ...dto.service },
              totalTaxPercents: {
                federal: dto.values.totalFederalTaxPercent,
                state: dto.values.totalStateTaxPercent,
                municipal: dto.values.totalMunicipalTaxPercent,
              },
            });
            const signedDpsXml = signDps({
              xml: built.xml,
              idAttribute: built.idAttribute,
              material: signing,
            });
            assertXsd(signedDpsXml);
            const invoice = await tx.fiscalInvoice.create({
              data: {
                cnpj,
                environment: dto.environment,
                externalId: dto.externalId,
                idempotencyKey: key,
                requestHash: hash,
                request: JSON.parse(JSON.stringify(dto)) as Prisma.InputJsonValue,
                cityCode: dto.issuer.cityCode,
                series: config.series,
                number,
                dpsId: built.dpsId,
                issuedAt,
                signedDpsXml,
                certificateId: material.id,
                webhookUrl: config.webhookUrl,
                webhookSecretCipher: config.webhookSecretCipher,
                tasks: { create: { kind: 'ISSUE' } },
              },
            });
            return invoice.id;
          },
          { maxWait: 10000, timeout: 20000 },
        );
        return this.find(cnpj, id);
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          ['P2002', 'P2034'].includes(e.code)
        ) {
          const found = await this.db.fiscalInvoice.findUnique({ where });
          if (found) {
            if (found.requestHash !== hash)
              throw new ConflictException('Chave de idempotência já utilizada com outro conteúdo');
            return this.find(cnpj, found.id);
          }
          if (attempt < 3) continue;
          throw new ConflictException('Disputa de numeração; repita com a mesma chave');
        }
        throw e;
      }
    }
    throw new ConflictException('Não foi possível reservar numeração');
  }
  async cancel(cnpj: string, id: string, dto: CancelInvoiceDto, key: string | undefined) {
    assertIdempotencyKey(key);
    const invoice = await this.db.fiscalInvoice.findFirst({ where: { id, cnpj } });
    if (!invoice) throw new NotFoundException('Pedido fiscal não encontrado');
    const hash = requestHash(dto);
    const previous = await this.db.fiscalTask.findFirst({
      where: { invoiceId: id, kind: 'CANCEL', payload: { path: '$.idempotencyKey', equals: key } },
    });
    if (previous) {
      if ((previous.payload as { requestHash: string }).requestHash !== hash)
        throw new ConflictException('Chave de cancelamento já utilizada com outro conteúdo');
      return this.find(cnpj, id);
    }
    if (invoice.cancellationKey === key) {
      if (invoice.cancellationHash !== hash)
        throw new ConflictException('Chave de cancelamento já utilizada com outro conteúdo');
      return this.find(cnpj, id);
    }
    if (
      invoice.status !== 'AUTHORIZED' ||
      !invoice.accessKey ||
      invoice.cancellationStatus === 'PENDING'
    )
      throw new ConflictException('Nota não disponível para cancelamento');
    const config = await this.db.fiscalCityConfig.findUnique({
      where: {
        cnpj_cityCode_environment: {
          cnpj,
          cityCode: invoice.cityCode,
          environment: invoice.environment,
        },
      },
    });
    if (
      config?.cancellationWindowDays != null &&
      invoice.authorizedAt &&
      Date.now() > invoice.authorizedAt.getTime() + config.cancellationWindowDays * 86400000
    )
      throw new BadRequestException('Prazo configurado para cancelamento encerrado');
    const material = await this.configs.material(cnpj);
    const built = buildCancellationEvent({
      environment: invoice.environment === 'PRODUCTION' ? '1' : '2',
      requestedAt: new Date(),
      applicationVersion: 'FiscalService 0.1',
      authorCnpj: cnpj,
      accessKey: invoice.accessKey,
      reasonCode: dto.reasonCode,
      reason: dto.reason,
    });
    const signed = signCancellationEvent({
      xml: built.xml,
      idAttribute: built.idAttribute,
      material: extractSigningMaterial(material.pfx, material.passphrase),
    });
    assertXsd(signed, PED_REG_EVENTO_SCHEMA);
    try {
      await this.db.$transaction(async (tx) => {
        const claimed = await tx.fiscalInvoice.updateMany({
          where: {
            id,
            cnpj,
            status: 'AUTHORIZED',
            OR: [{ cancellationStatus: null }, { cancellationStatus: 'REJECTED' }],
          },
          data: {
            cancellationKey: key,
            cancellationHash: hash,
            cancellationRequest: JSON.parse(JSON.stringify(dto)),
            cancellationStatus: 'PENDING',
            signedCancellationXml: signed,
            lastError: null,
          },
        });
        if (!claimed.count)
          throw new ConflictException(
            'Cancelamento já solicitado; use a mesma chave para consultar',
          );
        await tx.fiscalTask.create({
          data: {
            invoiceId: id,
            kind: 'CANCEL',
            payload: { certificateId: material.id, idempotencyKey: key, requestHash: hash },
          },
        });
      });
    } catch (error) {
      const current = await this.db.fiscalInvoice.findFirst({ where: { id, cnpj } });
      if (current?.cancellationKey === key && current.cancellationHash === hash)
        return this.find(cnpj, id);
      throw error;
    }
    return this.find(cnpj, id);
  }
  async retry(cnpj: string, id: string) {
    await this.find(cnpj, id);
    await this.db.$transaction(async (tx) => {
      const failed = await tx.fiscalTask.findMany({ where: { invoiceId: id, status: 'FAILED' } });
      if (!failed.length) throw new ConflictException('Nenhuma tarefa esgotada para repetir');
      for (const task of failed) {
        const result = await tx.fiscalTask.updateMany({
          where: { id: task.id, status: 'FAILED' },
          data: { status: 'DONE' },
        });
        if (result.count)
          await tx.fiscalTask.create({
            data: {
              invoiceId: id,
              kind: task.kind,
              ...(task.payload ? { payload: task.payload as Prisma.InputJsonValue } : {}),
            },
          });
      }
      await tx.fiscalInvoice.update({ where: { id }, data: { lastError: null } });
    });
    return this.find(cnpj, id);
  }
}
