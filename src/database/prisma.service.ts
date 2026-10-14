import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const url = new URL(process.env.DATABASE_URL!);
    super({
      adapter: new PrismaMariaDb({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.slice(1),
        connectionLimit: 5,
      }),
    });
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
