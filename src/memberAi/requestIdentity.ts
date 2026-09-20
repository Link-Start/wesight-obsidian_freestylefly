import { createHash, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/** Retain identity across SDK transport retries; never cache prompts or responses. */
export class MemberRequestIdentity {
  private attempts = new Map<string, { id: string; at: number }>();
  clear(): void {
    this.attempts.clear();
  }
  resolve(body: Buffer, headers: IncomingHttpHeaders, now = Date.now()): string {
    for (const [key, item] of this.attempts) if (now - item.at > 15 * 60_000) this.attempts.delete(key);
    const explicit = headers['idempotency-key'];
    const key = createHash('sha256')
      .update(body)
      .update(typeof explicit === 'string' ? explicit.slice(0, 256) : '')
      .digest('hex');
    const retry = Number(headers['x-stainless-retry-count'] ?? 0);
    const previous = this.attempts.get(key);
    if (retry > 0 || explicit) {
      if (previous) return previous.id;
      if (retry > 0) throw new Error('重试请求已过期，请重新发送。');
    }
    if (this.attempts.size >= 512) throw new Error('本机请求较多，请稍后重试。');
    const id = randomUUID();
    this.attempts.set(key, { id, at: now });
    return id;
  }
}
