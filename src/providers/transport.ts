import https from 'node:https';
import http, { type IncomingMessage } from 'node:http';

/** Node transport works inside Obsidian without renderer CORS or redirecting secrets. */
export function providerRequest(url: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
} = {}, providerName = '模型服务'): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, {
      method: options.method ?? 'GET', headers: options.headers, signal: options.signal,
    }, resolve);
    request.on('error', () => reject(new Error(`${providerName} 网络连接失败，请稍后重试。`)));
    request.setTimeout(120_000, () => request.destroy());
    request.end(options.body);
  });
}

export async function readProviderJson(response: IncomingMessage, providerName = '模型服务'): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) {
      response.destroy();
      throw new Error(`${providerName} 响应超出大小限制。`);
    }
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error(`${providerName} 返回了无效响应。`); }
}
