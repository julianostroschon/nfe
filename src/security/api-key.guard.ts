import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

export type TenantRequest = Request & { emitterCnpj: string };
type Credential = { sha256: string; cnpjs: string[] };

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly credentials: Credential[];
  constructor() {
    this.credentials = JSON.parse(process.env.API_KEY_HASHES_JSON ?? '[]') as Credential[];
    if (
      !Array.isArray(this.credentials) ||
      !this.credentials.length ||
      this.credentials.some(
        (c) =>
          !/^[a-f0-9]{64}$/i.test(c.sha256) ||
          !Array.isArray(c.cnpjs) ||
          !c.cnpjs.length ||
          c.cnpjs.some((n) => !/^\d{14}$/.test(n)),
      )
    )
      throw new Error('API_KEY_HASHES_JSON inválido');
  }
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<TenantRequest>();
    const key = req.header('X-API-Key');
    if (!key) throw new UnauthorizedException('API key ausente');
    const hash = createHash('sha256').update(key).digest();
    const matched = this.credentials.find((c) =>
      timingSafeEqual(hash, Buffer.from(c.sha256, 'hex')),
    );
    if (!matched) throw new UnauthorizedException('API key inválida');
    const cnpj = req.header('X-Emitter-Cnpj');
    if (!cnpj || !matched.cnpjs.includes(cnpj))
      throw new ForbiddenException('Emitente não autorizado');
    req.emitterCnpj = cnpj;
    return true;
  }
}
