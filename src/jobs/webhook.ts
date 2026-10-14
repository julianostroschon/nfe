import { createHmac } from 'node:crypto';

/** O destinatário valida a assinatura sobre bytes recebidos, sem reserializar. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
export async function deliverWebhook(url: string, secret: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Timestamp': timestamp,
      'X-Webhook-Signature': `sha256=${webhookSignature(secret, timestamp, body)}`,
      'X-Webhook-Event-Id': (payload as { eventId: string }).eventId,
    },
    body,
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Webhook respondeu HTTP ${response.status}`);
}
