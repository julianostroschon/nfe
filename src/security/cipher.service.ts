import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/** AES-256-GCM: banco novo aceita somente valores cifrados autenticados. */
@Injectable()
export class CipherService {
  private readonly key: Buffer;
  constructor() {
    const raw = process.env.CREDENTIALS_ENCRYPTION_KEY ?? '';
    this.key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (this.key.length !== 32)
      throw new Error('CREDENTIALS_ENCRYPTION_KEY deve ter 32 bytes em base64 ou hexadecimal');
  }
  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [
      'enc',
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      data.toString('base64url'),
    ].join(':');
  }
  decrypt(value: string): string {
    const [prefix, version, iv, tag, data, extra] = value.split(':');
    if (
      prefix !== 'enc' ||
      version !== 'v1' ||
      !iv ||
      !tag ||
      data === undefined ||
      extra !== undefined
    )
      throw new Error('Segredo cifrado inválido');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
