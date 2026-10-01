import { setTimeout, clearTimeout } from 'node:timers';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProviderProfile } from '../types';
import { anthropicToOpenAI, openAIToAnthropic, formatSSEEvent } from '../providers/format';
import { pipeChatAsMessages } from '../providers/stream';
import { providerRequest, readProviderJson } from '../providers/transport';
import { parseOpenLuxCatalog, type CatalogModel } from './catalog';
import { OPEN_LUX } from './constants';

export function isOpenLuxProfile(profile: ProviderProfile | null): boolean {
  if (!profile) return false;
  if (profile.providerKey) return profile.providerKey === OPEN_LUX.key;
  return profile.name.trim().toLowerCase() === OPEN_LUX.key;
}

export function openLuxError(status: number): string {
  if (status === 401 || status === 403) return `OpenLux 鉴权失败（${status}），请检查 API Key 和模型权限。`;
  if (status === 402) return 'OpenLux 余额或密钥额度不足，请前往官网检查。';
  if (status === 429) return 'OpenLux 请求受限（429），请稍后重试。';
  return `OpenLux 请求失败（${status}），请检查模型、服务状态后重试。`;
}

function baseUrl(value: string): string {
  const url = new URL(value.trim() || OPEN_LUX.baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OpenLux API Base URL 无效。');
  }
  return url.toString().replace(/\/+$/, '');
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

interface Session {
  profile: ProviderProfile;
  requests: Set<AbortController>;
  release: () => void;
}

export interface OpenLuxRuntimeLease {
  profile: ProviderProfile;
  release: () => void;
}

/** Each local credential owns a snapshot, so concurrent turns cannot change each other's upstream. */
export class OpenLuxService {
  private gateway?: Server;
  private starting?: Promise<void>;
  private gatewayUrl = '';
  private closed = false;
  private readonly sessions = new Map<string, Session>();
  private readonly requests = new Set<AbortController>();

  constructor(private readonly request: typeof providerRequest = providerRequest) {}

  async fetchCatalog(config: { baseUrl: string; apiKey: string }, signal?: AbortSignal): Promise<CatalogModel[]> {
    if (!config.apiKey.trim()) throw new Error('请先输入 OpenLux API Key。');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 15_000);
    this.requests.add(controller);
    try {
      if (this.closed) throw new Error();
      const base = baseUrl(config.baseUrl);
      const response = await this.request(`${base.endsWith('/v1') ? base : `${base}/v1`}/models`, {
        headers: { Authorization: `Bearer ${config.apiKey.trim()}` }, signal: controller.signal,
      });
      if (response.statusCode !== 200) {
        response.destroy();
        throw new Error(openLuxError(response.statusCode ?? 502));
      }
      return parseOpenLuxCatalog(await readProviderJson(response));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('OpenLux ')) throw error;
      throw new Error(controller.signal.aborted ? 'OpenLux 模型目录请求已取消或超时。' : '无法获取 OpenLux 模型目录，请检查网络后重试。');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      this.requests.delete(controller);
    }
  }

  async acquire(profile: ProviderProfile, signal?: AbortSignal): Promise<OpenLuxRuntimeLease> {
    if (this.closed || signal?.aborted) throw new Error('OpenLux 请求已取消或服务已关闭。');
    if (profile.agentId !== 'claude') throw new Error('OpenLux 当前仅支持 Claude Code。');
    if (!profile.apiKey.trim()) throw new Error('请先输入 OpenLux API Key。');
    if (!(profile.defaultModel || profile.model)) throw new Error('请先选择 OpenLux 默认模型。');
    const snapshot = { ...profile, baseUrl: baseUrl(profile.baseUrl), models: [...profile.models] };
    await this.start();
    if (this.closed || signal?.aborted) throw new Error('OpenLux 请求已取消或服务已关闭。');
    const token = randomBytes(32).toString('base64url');
    const session: Session = { profile: snapshot, requests: new Set(), release: () => {
      this.sessions.delete(token);
      signal?.removeEventListener('abort', session.release);
      for (const controller of session.requests) controller.abort();
    } };
    this.sessions.set(token, session);
    signal?.addEventListener('abort', session.release, { once: true });
    return {
      profile: { ...snapshot, apiKey: token, baseUrl: this.gatewayUrl, anthropicAuthMode: 'authToken' },
      release: session.release,
    };
  }

  private async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.gateway?.listening) return;
    this.starting = (async () => {
      const server = createServer((request, response) => { void this.handleRequest(request, response); });
      this.gateway = server;
      server.requestTimeout = 120_000;
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      if (this.closed) { server.close(); throw new Error('OpenLux 服务已关闭。'); }
      this.gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    })();
    try { await this.starting; }
    catch { this.gateway?.close(); this.gateway = undefined; throw new Error('无法启动 OpenLux 本机连接。'); }
    finally { this.starting = undefined; }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = request.headers.authorization ?? request.headers['x-api-key'];
    const session = typeof authorization === 'string' ? this.sessions.get(authorization.replace(/^Bearer\s+/i, '')) : undefined;
    if (!session) { json(response, 401, { error: { message: '无效的 OpenLux 本机凭据。' } }); return; }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(path)) {
      json(response, 404, { error: { message: '不支持此接口。' } }); return;
    }
    const controller = new AbortController();
    session.requests.add(controller);
    this.requests.add(controller);
    const abort = (): void => controller.abort();
    response.on('close', abort);
    const timeout = setTimeout(abort, 10 * 60_000);
    let upstream: IncomingMessage | undefined;
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) { json(response, 413, { error: { message: 'OpenLux 请求过大。' } }); return; }
        chunks.push(Buffer.from(chunk));
      }
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch { json(response, 400, { error: { message: 'OpenLux 请求格式无效。' } }); return; }
      const profile = session.profile;
      const allowed = new Set([...profile.models, profile.defaultModel || profile.model]);
      if (typeof body.model !== 'string' || !allowed.has(body.model)) {
        json(response, 400, { error: { message: '请选择已配置的 OpenLux 模型。' } }); return;
      }
      if (path.endsWith('/count_tokens')) {
        const estimate = Math.ceil(Buffer.byteLength(JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools })) / 2);
        json(response, 200, { input_tokens: Math.max(1, estimate) }); return;
      }
      const base = profile.baseUrl.endsWith('/v1') ? profile.baseUrl : `${profile.baseUrl}/v1`;
      upstream = await this.request(`${base}/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
        body: JSON.stringify(anthropicToOpenAI(body)),
      });
      const status = upstream.statusCode ?? 502;
      if (status < 200 || status >= 300) {
        upstream.destroy();
        json(response, status, { type: 'error', error: { type: 'api_error', message: openLuxError(status) } }); return;
      }
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        await pipeChatAsMessages(upstream, response, body.model, controller.signal, 'OpenLux');
      } else {
        const value = await readProviderJson(upstream);
        if (!value || typeof value !== 'object' || !('choices' in value) || !Array.isArray(value.choices) || !value.choices.length) throw new Error();
        const converted = openAIToAnthropic(value);
        if (!Array.isArray(converted.content) || !converted.content.length) throw new Error();
        json(response, 200, converted);
      }
    } catch {
      const error = { type: 'api_error', message: controller.signal.aborted
        ? 'OpenLux 请求已取消或超时。' : 'OpenLux 请求或协议转换失败，请检查模型和网络后重试。' };
      if (!response.destroyed) {
        if (!response.headersSent) json(response, 502, { type: 'error', error });
        else response.end(formatSSEEvent('error', { type: 'error', error }));
      }
    } finally {
      upstream?.destroy();
      clearTimeout(timeout);
      response.off('close', abort);
      session.requests.delete(controller);
      this.requests.delete(controller);
    }
  }

  async test(profile: ProviderProfile, signal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 60_000);
    let lease: OpenLuxRuntimeLease | undefined;
    try {
      lease = await this.acquire(profile, controller.signal);
      const response = await this.request(`${lease.profile.baseUrl}/v1/messages`, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${lease.profile.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: profile.defaultModel || profile.model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
      });
      const value = await readProviderJson(response) as { type?: string; content?: unknown[] };
      if (response.statusCode !== 200) throw new Error(openLuxError(response.statusCode ?? 502));
      if (value.type !== 'message' || !Array.isArray(value.content) || !value.content.length) throw new Error('OpenLux 未返回有效消息。');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('OpenLux ')) throw error;
      throw new Error(controller.signal.aborted ? 'OpenLux 连接测试超时。' : 'OpenLux 连接测试失败，请检查网络后重试。');
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); lease?.release(); }
  }

  close(): void {
    this.closed = true;
    for (const session of this.sessions.values()) session.release();
    for (const controller of this.requests) controller.abort();
    this.gateway?.close();
    this.gateway?.closeAllConnections();
    this.gateway = undefined;
  }
}
