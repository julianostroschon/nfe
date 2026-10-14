import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, CertificateStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CipherService } from '../security/cipher.service';
import { readPkcs12 } from '../certificates/pkcs12.reader';
import { extractSigningMaterial } from '../core/dps.signer';
import { CreateCertificateDto, CreateCityConfigDto, UpdateCityConfigDto } from './config.dto';

export const CERTIFICATE_PUBLIC_SELECT = {
  id: true,
  cnpj: true,
  subjectName: true,
  fingerprint: true,
  validFrom: true,
  validUntil: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.FiscalCertificateSelect;
export const CONFIG_PUBLIC_SELECT = {
  id: true,
  cnpj: true,
  cityCode: true,
  environment: true,
  enabled: true,
  series: true,
  cancellationWindowDays: true,
  webhookUrl: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.FiscalCityConfigSelect;

@Injectable()
export class ConfigsService {
  constructor(
    private readonly db: PrismaService,
    private readonly cipher: CipherService,
  ) {}
  async createCertificate(cnpj: string, dto: CreateCertificateDto) {
    const file = Buffer.from(dto.pfxBase64, 'base64');
    if (file.length > 1024 * 1024) throw new BadRequestException('Certificado excede 1 MB');
    const meta = readPkcs12(file, dto.password);
    if (meta.cnpj !== cnpj)
      throw new BadRequestException('CNPJ do certificado não corresponde ao emitente autorizado');
    if (meta.validFrom > new Date() || meta.validUntil <= new Date())
      throw new BadRequestException('Certificado fora da validade');
    extractSigningMaterial(file, dto.password);
    try {
      return await this.db.$transaction(async (tx) => {
        const active = await tx.fiscalCertificate.findFirst({ where: { cnpj, status: 'ACTIVE' } });
        if (active)
          await tx.fiscalCertificate.update({
            where: { id: active.id },
            data: { status: 'REPLACED', activeSlot: active.id },
          });
        return tx.fiscalCertificate.create({
          data: {
            ...meta,
            cnpj,
            fileCipher: this.cipher.encrypt(file.toString('base64')),
            passwordCipher: this.cipher.encrypt(dto.password),
          },
          select: CERTIFICATE_PUBLIC_SELECT,
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException(
          'Outro certificado foi ativado simultaneamente; tente novamente',
        );
      throw e;
    }
  }
  listCertificates(cnpj: string) {
    return this.db.fiscalCertificate.findMany({
      where: { cnpj },
      select: CERTIFICATE_PUBLIC_SELECT,
    });
  }
  async certificate(cnpj: string, id: string) {
    const row = await this.db.fiscalCertificate.findFirst({
      where: { id, cnpj },
      select: CERTIFICATE_PUBLIC_SELECT,
    });
    if (!row) throw new NotFoundException('Certificado não encontrado');
    return row;
  }
  async revokeCertificate(cnpj: string, id: string) {
    await this.certificate(cnpj, id);
    await this.db.fiscalCertificate.updateMany({
      where: { id, cnpj },
      data: { status: CertificateStatus.REVOKED, activeSlot: id },
    });
    return this.certificate(cnpj, id);
  }
  async material(cnpj: string, id?: string) {
    const row = await this.db.fiscalCertificate.findFirst({
      where: { cnpj, ...(id ? { id, status: { not: 'REVOKED' } } : { status: 'ACTIVE' }) },
    });
    if (!row || row.validFrom > new Date() || row.validUntil <= new Date())
      throw new BadRequestException('Certificado válido não disponível');
    return {
      id: row.id,
      pfx: Buffer.from(this.cipher.decrypt(row.fileCipher), 'base64'),
      passphrase: this.cipher.decrypt(row.passwordCipher),
    };
  }
  private webhookData(dto: CreateCityConfigDto | UpdateCityConfigDto) {
    const { webhookSecret, ...data } = dto;
    if (dto.webhookUrl) {
      const url = new URL(dto.webhookUrl);
      if (url.username || url.password)
        throw new BadRequestException('URL do webhook não pode conter credenciais');
    }
    if (
      data.environment === 'PRODUCTION' &&
      data.webhookUrl &&
      !data.webhookUrl.startsWith('https://')
    )
      throw new BadRequestException('Webhook de produção exige HTTPS');
    return {
      ...data,
      ...(webhookSecret ? { webhookSecretCipher: this.cipher.encrypt(webhookSecret) } : {}),
    };
  }
  async createConfig(cnpj: string, dto: CreateCityConfigDto) {
    if (!!dto.webhookUrl !== !!dto.webhookSecret)
      throw new BadRequestException('Informe URL e segredo do webhook juntos');
    try {
      return await this.db.fiscalCityConfig.create({
        data: { cnpj, ...this.webhookData(dto) } as Prisma.FiscalCityConfigUncheckedCreateInput,
        select: CONFIG_PUBLIC_SELECT,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException('Configuração já existe');
      throw e;
    }
  }
  listConfigs(cnpj: string) {
    return this.db.fiscalCityConfig.findMany({ where: { cnpj }, select: CONFIG_PUBLIC_SELECT });
  }
  async config(cnpj: string, id: string) {
    const row = await this.db.fiscalCityConfig.findFirst({
      where: { id, cnpj },
      select: CONFIG_PUBLIC_SELECT,
    });
    if (!row) throw new NotFoundException('Configuração não encontrada');
    return row;
  }
  async updateConfig(cnpj: string, id: string, dto: UpdateCityConfigDto) {
    const existing = await this.db.fiscalCityConfig.findFirst({ where: { id, cnpj } });
    if (!existing) throw new NotFoundException('Configuração não encontrada');
    const environment = dto.environment ?? existing.environment;
    const webhookUrl = dto.webhookUrl ?? existing.webhookUrl;
    const secret = dto.webhookSecret ?? existing.webhookSecretCipher;
    if (!!webhookUrl !== !!secret)
      throw new BadRequestException('Webhook exige URL e segredo juntos');
    if (environment === 'PRODUCTION' && webhookUrl && !webhookUrl.startsWith('https://'))
      throw new BadRequestException('Webhook de produção exige HTTPS');
    try {
      await this.db.fiscalCityConfig.updateMany({
        where: { id, cnpj },
        data: this.webhookData(dto),
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException('Configuração já existe');
      throw e;
    }
    return this.config(cnpj, id);
  }
  async deleteConfig(cnpj: string, id: string) {
    await this.config(cnpj, id);
    await this.db.fiscalCityConfig.deleteMany({ where: { id, cnpj } });
  }
}
