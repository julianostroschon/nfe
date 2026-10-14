import { randomUUID } from 'node:crypto';
import { InjectQueue, Process, Processor } from '@nestjs/bull';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FiscalInvoice, Prisma } from '@prisma/client';
import type { Job, Queue } from 'bull';
import { ConfigsService } from '../configs/configs.service';
import { PrismaService } from '../database/prisma.service';
import { NfseNationalClient } from '../core/nfse-national.client';
import { CipherService } from '../security/cipher.service';
import { deliverWebhook } from './webhook';

export const QUEUE_NAME = 'fiscal-tasks';
const MAX_ATTEMPTS = 6;
const LEASE_MS = 300000;

/** Publicação recuperável: uma falha entre commit MySQL e Redis não perde a intenção. */
@Injectable()
export class TaskDispatcher implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly logger = new Logger(TaskDispatcher.name);
  constructor(
    private readonly db: PrismaService,
    @InjectQueue(QUEUE_NAME) private readonly queue: Queue,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();
      const tasks = await this.db.fiscalTask.findMany({
        where: {
          OR: [
            { status: 'PENDING', availableAt: { lte: now } },
            { status: 'PROCESSING', lockUntil: { lte: now } },
          ],
        },
        take: 100,
        orderBy: { availableAt: 'asc' },
      });
      for (const task of tasks)
        await this.queue.add(
          'run',
          { taskId: task.id },
          {
            jobId: `${task.id}-${task.attempts}`,
            attempts: 1,
            removeOnComplete: 1000,
            removeOnFail: 1000,
          },
        );
    } catch {
      this.logger.warn('Publicação fiscal indisponível; intenções permanecem no banco');
    } finally {
      this.ticking = false;
    }
  }
}

@Processor(QUEUE_NAME)
export class TasksWorker {
  constructor(
    private readonly db: PrismaService,
    private readonly configs: ConfigsService,
    private readonly cipher: CipherService,
  ) {}
  private client(environment: string) {
    return new NfseNationalClient(
      new ConfigService({
        NFSE_ENVIRONMENT: environment,
        NFSE_BASE_URL_OVERRIDE: process.env.NFSE_BASE_URL_OVERRIDE,
      }),
    );
  }
  private async commitResult(
    taskId: string,
    owner: string,
    invoice: FiscalInvoice,
    type: string,
    data: Prisma.FiscalInvoiceUpdateInput,
    code?: string,
    message?: string,
  ) {
    await this.db.$transaction(async (tx) => {
      const claim = await tx.fiscalTask.updateMany({
        where: { id: taskId, lockOwner: owner, status: 'PROCESSING' },
        data: { status: 'DONE', lockOwner: null, lockUntil: null, lastError: null },
      });
      if (!claim.count) throw new Error('Reserva de processamento expirou');
      const updated = await tx.fiscalInvoice.update({ where: { id: invoice.id }, data });
      const event = await tx.fiscalEvent.create({
        data: { invoiceId: invoice.id, type, code, message: message?.slice(0, 1000) },
      });
      if (invoice.webhookUrl && invoice.webhookSecretCipher) {
        const payload = {
          eventId: event.id,
          type,
          occurredAt: event.createdAt.toISOString(),
          invoiceId: invoice.id,
          externalId: invoice.externalId,
          emitterCnpj: invoice.cnpj,
          environment: invoice.environment,
          status: updated.status,
          cancellationStatus: updated.cancellationStatus,
          dpsId: invoice.dpsId,
          accessKey: updated.accessKey,
          result: { code: code ?? null, message: message?.slice(0, 1000) ?? null },
        };
        await tx.fiscalTask.create({ data: { invoiceId: invoice.id, kind: 'WEBHOOK', payload } });
      }
    });
  }
  @Process({ name: 'run', concurrency: 4 })
  async run(job: Job<{ taskId: string }>) {
    const now = new Date();
    const owner = randomUUID();
    const claimed = await this.db.fiscalTask.updateMany({
      where: {
        id: job.data.taskId,
        OR: [
          { status: 'PENDING', availableAt: { lte: now } },
          { status: 'PROCESSING', lockUntil: { lte: now } },
        ],
      },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        lockUntil: new Date(now.getTime() + LEASE_MS),
        lockOwner: owner,
      },
    });
    if (!claimed.count) return;
    const task = await this.db.fiscalTask.findUniqueOrThrow({
      where: { id: job.data.taskId },
      include: { invoice: true },
    });
    const invoice = task.invoice;
    try {
      if (task.kind === 'WEBHOOK') {
        if (!invoice.webhookUrl || !invoice.webhookSecretCipher || !task.payload)
          throw new BadRequestException('Destino do webhook indisponível');
        await deliverWebhook(
          invoice.webhookUrl,
          this.cipher.decrypt(invoice.webhookSecretCipher),
          task.payload,
        );
        await this.db.fiscalTask.updateMany({
          where: { id: task.id, lockOwner: owner },
          data: { status: 'DONE', lockOwner: null, lockUntil: null, lastError: null },
        });
        return;
      }
      const client = this.client(invoice.environment);
      const certificateId =
        task.kind === 'CANCEL'
          ? (task.payload as { certificateId: string }).certificateId
          : invoice.certificateId;
      const credentials = await this.configs.material(invoice.cnpj, certificateId);
      await this.db.fiscalInvoice.update({
        where: { id: invoice.id },
        data: { attemptCount: { increment: 1 } },
      });
      if (task.kind === 'ISSUE') {
        if (invoice.status !== 'PENDING') {
          await this.db.fiscalTask.updateMany({
            where: { id: task.id, lockOwner: owner },
            data: { status: 'DONE', lockOwner: null, lockUntil: null },
          });
          return;
        }
        // Consultar antes de reenviar, inclusive na primeira execução após uma retomada.
        const existing = await client.findExistingByDpsId({ dpsId: invoice.dpsId, credentials });
        let result =
          existing.exists && existing.accessKey
            ? await client.getInvoice({ accessKey: existing.accessKey, credentials })
            : await client.issue({ signedDpsXml: invoice.signedDpsXml, credentials });
        if (!result.authorized && !this.inconclusive(result.raw.status, result.code)) {
          const after = await client.findExistingByDpsId({ dpsId: invoice.dpsId, credentials });
          if (after.exists && after.accessKey)
            result = await client.getInvoice({ accessKey: after.accessKey, credentials });
        }
        if (result.authorized && !result.nfseXml && result.accessKey)
          result = await client.getInvoice({ accessKey: result.accessKey, credentials });
        if (!result.authorized && this.inconclusive(result.raw.status, result.code))
          throw new Error('Transmissão sem confirmação fiscal');
        await this.commitResult(
          task.id,
          owner,
          invoice,
          result.authorized ? 'invoice.authorized' : 'invoice.rejected',
          {
            status: result.authorized ? 'AUTHORIZED' : 'REJECTED',
            accessKey: result.accessKey,
            authorizedXml: result.nfseXml,
            authorizedAt: result.authorized ? new Date() : null,
            lastError: result.authorized ? null : result.message?.slice(0, 1000),
          },
          result.code,
          result.message,
        );
      } else {
        if (!invoice.accessKey || !invoice.signedCancellationXml)
          throw new BadRequestException('Documento de cancelamento ausente');
        const existing = await client.findCancellation({
          accessKey: invoice.accessKey,
          credentials,
        });
        let result = existing.exists
          ? {
              registered: true,
              eventXml: existing.eventXml,
              code: undefined,
              message: undefined,
              raw: { status: 200 },
            }
          : await client.cancel({
              accessKey: invoice.accessKey,
              signedEventXml: invoice.signedCancellationXml,
              credentials,
            });
        if (!result.registered && !this.inconclusive(result.raw.status, result.code)) {
          const after = await client.findCancellation({
            accessKey: invoice.accessKey,
            credentials,
          });
          if (after.exists)
            result = {
              registered: true,
              eventXml: after.eventXml,
              code: undefined,
              message: undefined,
              raw: { status: 200 },
            };
        }
        if (!result.registered && this.inconclusive(result.raw.status, result.code))
          throw new Error('Cancelamento sem confirmação fiscal');
        await this.commitResult(
          task.id,
          owner,
          invoice,
          result.registered ? 'invoice.canceled' : 'invoice.cancellation_rejected',
          {
            ...(result.registered
              ? {
                  status: 'CANCELED',
                  cancellationEventXml: 'eventXml' in result ? result.eventXml : null,
                }
              : {}),
            cancellationStatus: result.registered ? 'CONFIRMED' : 'REJECTED',
            lastError: result.registered ? null : result.message?.slice(0, 1000),
          },
          result.code,
          result.message,
        );
      }
    } catch (e) {
      const exhausted = task.attempts >= MAX_ATTEMPTS || e instanceof BadRequestException;
      // Erros internos não carregam material PKCS#12 nem resposta HTTP do webhook.
      const message =
        e instanceof BadRequestException
          ? 'Configuração fiscal indisponível; revise certificado e dados'
          : 'Falha técnica na transmissão ou entrega; nova tentativa necessária';
      await this.db.$transaction(async (tx) => {
        const updated = await tx.fiscalTask.updateMany({
          where: { id: task.id, lockOwner: owner },
          data: {
            status: exhausted ? 'FAILED' : 'PENDING',
            lockOwner: null,
            lockUntil: null,
            lastError: message,
            availableAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** task.attempts)),
          },
        });
        if (!updated.count || task.kind === 'WEBHOOK') return;
        await tx.fiscalInvoice.update({ where: { id: invoice.id }, data: { lastError: message } });
        if (exhausted) {
          const event = await tx.fiscalEvent.create({
            data: {
              invoiceId: invoice.id,
              type:
                task.kind === 'ISSUE'
                  ? 'invoice.transmission_failed'
                  : 'invoice.cancellation_failed',
              message,
            },
          });
          if (invoice.webhookUrl && invoice.webhookSecretCipher)
            await tx.fiscalTask.create({
              data: {
                invoiceId: invoice.id,
                kind: 'WEBHOOK',
                payload: {
                  eventId: event.id,
                  type: event.type,
                  occurredAt: event.createdAt.toISOString(),
                  invoiceId: invoice.id,
                  externalId: invoice.externalId,
                  emitterCnpj: invoice.cnpj,
                  environment: invoice.environment,
                  status: invoice.status,
                  cancellationStatus: invoice.cancellationStatus,
                  dpsId: invoice.dpsId,
                  accessKey: invoice.accessKey,
                  result: { code: null, message },
                },
              },
            });
        }
      });
    }
  }
  private inconclusive(status: number, code?: string) {
    return (
      status >= 500 || [408, 425, 429].includes(status) || (status >= 200 && status < 300) || !code
    );
  }
}
