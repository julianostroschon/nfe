import 'reflect-metadata';
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { BadRequestException, PipeTransform, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import { AppModule } from './app.module';
import { isXmlLintAvailable } from './core/xsd-validator';

/** Campos opcionais devem ser omitidos: null não pode contornar validação. */
class RejectNullPipe implements PipeTransform {
  transform(value: unknown) {
    const inspect = (v: unknown): void => {
      if (v === null) throw new BadRequestException('Omita campos opcionais em vez de enviar null');
      if (v && typeof v === 'object') for (const child of Object.values(v)) inspect(child);
    };
    inspect(value);
    return value;
  }
}
export async function createApplication() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL obrigatória');
  if (!isXmlLintAvailable()) throw new Error('xmllint obrigatório; instale libxml2-utils');
  if (
    process.env.NFSE_ENVIRONMENT &&
    !['HOMOLOGATION', 'PRODUCTION'].includes(process.env.NFSE_ENVIRONMENT)
  )
    throw new Error('NFSE_ENVIRONMENT inválido');
  if (process.env.NFSE_ENVIRONMENT === 'PRODUCTION' && process.env.NFSE_BASE_URL_OVERRIDE)
    throw new Error('Override proibido em produção');
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: process.env.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'],
  });
  app.use(json({ limit: '2mb' }));
  app.useGlobalPipes(
    new RejectNullPipe(),
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: { target: false, value: false },
    }),
  );
  app.enableShutdownHooks();
  const config = new DocumentBuilder()
    .setTitle('Serviço NFS-e Nacional')
    .setDescription(
      'Emissão assíncrona, consulta e cancelamento por emitente. Informe X-Emitter-Cnpj em todas as operações autenticadas.',
    )
    .setVersion('0.1.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key' }, 'apiKey')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);
  return { app, document };
}
async function bootstrap() {
  const { app, document } = await createApplication();
  if (process.env.GENERATE_SWAGGER === 'true') {
    writeFileSync('openapi.json', JSON.stringify(document, null, 2) + '\n');
    await app.close();
    return;
  }
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
if (require.main === module)
  void bootstrap().catch(() => {
    console.error('Não foi possível iniciar o serviço; confira configurações e dependências');
    process.exitCode = 1;
  });
