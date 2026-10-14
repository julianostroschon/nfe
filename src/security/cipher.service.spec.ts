import { randomBytes } from 'node:crypto';
import { CipherService } from './cipher.service';
import { canonicalJson, requestHash } from '../invoices/invoices.service';
import { webhookSignature } from '../jobs/webhook';

describe('Proteção de segredos e contratos', () => {
  beforeEach(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  });
  it('cifra com nonce distinto e recupera o conteúdo', () => {
    const cipher = new CipherService();
    const first = cipher.encrypt('senha de teste');
    const second = cipher.encrypt('senha de teste');
    expect(first).not.toBe(second);
    expect(first).not.toContain('senha de teste');
    expect(cipher.decrypt(first)).toBe('senha de teste');
  });
  it('recusa conteúdo adulterado e chave diferente', () => {
    const cipher = new CipherService();
    const parts = cipher.encrypt('material de teste').split(':');
    const buffer = Buffer.from(parts[4], 'base64url');
    buffer[0] ^= 1;
    parts[4] = buffer.toString('base64url');
    expect(() => cipher.decrypt(parts.join(':'))).toThrow();
    const encrypted = cipher.encrypt('material de teste');
    process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(() => new CipherService().decrypt(encrypted)).toThrow();
    expect(() => cipher.decrypt('texto não cifrado')).toThrow();
  });
  it('não aceita chave de tamanho errado', () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = 'curta';
    expect(() => new CipherService()).toThrow();
  });
  it('hash de idempotência ignora ordem, mas preserva valores e ordem de arrays', () => {
    expect(requestHash({ b: { y: 2, x: 1 }, a: 3 })).toBe(requestHash({ a: 3, b: { x: 1, y: 2 } }));
    expect(requestHash({ a: '1.00' })).not.toBe(requestHash({ a: '2.00' }));
    expect(requestHash([1, 2])).not.toBe(requestHash([2, 1]));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
  it('assinatura HMAC depende dos bytes e do instante', () => {
    const sig = webhookSignature('segredo de teste', '123', '{"a":1}');
    expect(sig).toHaveLength(64);
    expect(sig).not.toBe(webhookSignature('segredo de teste', '124', '{"a":1}'));
    expect(sig).not.toBe(webhookSignature('segredo de teste', '123', '{ "a":1}'));
  });
});
