import { Injectable } from '@nestjs/common';
import { Environment, Prisma } from '@prisma/client';

/** Reserva atômica por emitente, ambiente e série; usa a transação da criação. */
@Injectable()
export class DpsNumberingService {
  async reserve(
    tx: Pick<Prisma.TransactionClient, 'fiscalDpsSequence'>,
    cnpj: string,
    environment: Environment,
    series: string,
  ) {
    const counter = await tx.fiscalDpsSequence.upsert({
      where: { cnpj_environment_series: { cnpj, environment, series } },
      create: { cnpj, environment, series, nextNumber: 2 },
      update: { nextNumber: { increment: 1 } },
    });
    return counter.nextNumber - 1;
  }
}
