import { Module, Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Queue } from 'bull';
import { DpsNumberingService } from './core/dps-numbering.service';
import { PrismaService } from './database/prisma.service';
import { CipherService } from './security/cipher.service';
import { ApiKeyGuard } from './security/api-key.guard';
import { ConfigsService } from './configs/configs.service';
import { CertificatesController, CityConfigsController } from './configs/configs.controller';
import { InvoicesController } from './invoices/invoices.controller';
import { InvoicesService } from './invoices/invoices.service';
import { QUEUE_NAME, TaskDispatcher, TasksWorker } from './jobs/tasks.worker';

@ApiTags('Saúde')
@Controller('health')
class HealthController {
  constructor(
    private readonly db: PrismaService,
    @InjectQueue(QUEUE_NAME) private readonly queue: Queue,
  ) {}
  @Get()
  @ApiOperation({ summary: 'Verificar conexão com MySQL e Redis' })
  async health() {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([this.db.$queryRaw`SELECT 1`, this.queue.client.ping()]),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('timeout')), 2000);
        }),
      ]);
      return { status: 'ok', database: 'ok', queue: 'ok' };
    } catch {
      throw new ServiceUnavailableException('MySQL ou Redis indisponível');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({
        redis: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
        prefix:
          process.env.QUEUE_PREFIX ??
          `nfse-${new URL(process.env.DATABASE_URL!).pathname.slice(1)}`,
      }),
    }),
    BullModule.registerQueue({ name: QUEUE_NAME }),
  ],
  controllers: [
    HealthController,
    CertificatesController,
    CityConfigsController,
    InvoicesController,
  ],
  providers: [
    DpsNumberingService,
    PrismaService,
    CipherService,
    ApiKeyGuard,
    ConfigsService,
    InvoicesService,
    TaskDispatcher,
    TasksWorker,
  ],
})
export class AppModule {}
