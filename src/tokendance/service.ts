import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import type { SecretStorage } from 'obsidian';
import type { ProviderProfile } from '../types';
import { parseTokenDanceCatalog, TOKEN_DANCE, TOKEN_DANCE_MODELS, tokenDanceError, type TokenDanceModel } from './catalog';
import { anthropicToOpenAI, openAIToAnthropic, formatSSEEvent } from './format';
import { pipeChatAsMessages } from './stream';
import { readTokenDanceJson, tokenDanceRequest } from './transport';

interface Dependencies {
  secrets: Pick<SecretStorage, 'getSecret' | 'setSecret'>;
  openExternal: (url: string) => void | Promise<void>;
  request?: typeof tokenDanceRequest;
  authorizationTimeoutMs?: number;
}

export function isTokenDanceProfile(profile: ProviderProfile | null): boolean {
  return profile?.apiKey === TOKEN_DANCE.credentialRef
    || profile?.baseUrl === TOKEN_DANCE.baseUrl
    || profile?.baseUrl === `${TOKEN_DANCE.baseUrl}/v1`;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function equalToken(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== 'string') return false;
  const actual = Buffer.from(value.replace(/^Bearer\s+/i, ''));
  const token = Buffer.from(expected);
  return actual.length === token.length && timingSafeEqual(actual, token);
}

/** PKCE and secret isolation follow the desktop integration, with Obsidian SecretStorage. */
export class TokenDanceService {
  private readonly request: typeof tokenDanceRequest;
  private cancelAuthorization?: () => void;
  private catalog = TOKEN_DANCE_MODELS.map(model => ({ ...model }));
  private catalogTime = 0;
  private catalogPromise?: Promise<TokenDanceModel[]>;
  private gateway?: Server;
  private starting?: Promise<void>;
  private gatewayUrl = '';
  private gatewayToken = randomBytes(32).toString('base64url');
  private requests = new Set<AbortController>();
  private closed = false;

  constructor(private readonly deps: Dependencies) {
    this.request = deps.request ?? tokenDanceRequest;
  }

  get connected(): boolean { return Boolean(this.readKey()); }
  get authorizing(): boolean { return Boolean(this.cancelAuthorization); }
  get models(): TokenDanceModel[] { return this.catalog.map(model => ({ ...model, supportedProtocols: [...model.supportedProtocols] })); }
  get catalogVerified(): boolean { return this.catalogTime > 0; }
  private readKey(): string { return this.deps.secrets.getSecret(TOKEN_DANCE.secretId)?.trim() ?? ''; }

  cancel(): void { this.cancelAuthorization?.(); }

  disconnect(): void {
    this.cancel();
    for (const controller of this.requests) controller.abort();
    this.deps.secrets.setSecret(TOKEN_DANCE.secretId, '');
    this.gatewayToken = randomBytes(32).toString('base64url');
  }

  refreshCatalog(): Promise<TokenDanceModel[]> {
    if (this.closed) return Promise.reject(new Error('TokenDance 服务已关闭。'));
    if (this.catalogPromise) return this.catalogPromise;
    this.catalogPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      this.requests.add(controller);
      try {
        const response = await this.request(TOKEN_DANCE.catalogUrl, { signal: controller.signal });
        if (response.statusCode !== 200) { response.destroy(); throw new Error(); }
        const models = parseTokenDanceCatalog(await readTokenDanceJson(response));
        this.catalog = models;
        this.catalogTime = Date.now();
        return this.models;
      } catch { throw new Error('无法获取 TokenDance 实时模型目录，请检查网络后重试。'); }
      finally { clearTimeout(timer); this.requests.delete(controller); this.catalogPromise = undefined; }
    })();
    return this.catalogPromise;
  }

  async authorize(): Promise<void> {
    if (this.closed) throw new Error('TokenDance 服务已关闭。');
    this.cancel();
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const callbackPath = `/callback/${randomBytes(24).toString('hex')}`;
    const controller = new AbortController();
    let rejectCode: (error: Error) => void = () => {};
    let acceptCode: (code: string) => void = () => {};
    let accepted = false;
    const codePromise = new Promise<string>((resolve, reject) => { acceptCode = resolve; rejectCode = reject; });
    void codePromise.catch(() => {});
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method !== 'GET' || url.pathname !== callbackPath || accepted) {
        response.writeHead(404).end(); return;
      }
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096) { response.writeHead(400).end(); return; }
      accepted = true;
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'" })
        .end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>WeSight</title><h1>已收到授权</h1><p>请返回 Obsidian 查看连接结果。</p></html>');
      acceptCode(code);
    });
    const cancel = (): void => { controller.abort(); rejectCode(new Error()); server.close(); server.closeAllConnections(); };
    this.cancelAuthorization = cancel;
    const timer = setTimeout(cancel, this.deps.authorizationTimeoutMs ?? 10 * 60_000);
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const auth = new URL(TOKEN_DANCE.authUrl);
      auth.searchParams.set('callback_url', `http://127.0.0.1:${(server.address() as AddressInfo).port}${callbackPath}`);
      auth.searchParams.set('code_challenge', challenge);
      auth.searchParams.set('code_challenge_method', 'S256');
      auth.searchParams.set('app_url', 'https://wesight.ai');
      auth.searchParams.set('key_name', 'WeSight Obsidian');
      await this.deps.openExternal(auth.toString());
      const code = await codePromise;
      server.close();
      const response = await this.request(TOKEN_DANCE.exchangeUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      });
      if (response.statusCode !== 200) { response.destroy(); throw new Error(); }
      const value = await readTokenDanceJson(response);
      if (controller.signal.aborted || this.closed) throw new Error();
      if (!value || typeof value !== 'object' || !('key' in value) || typeof value.key !== 'string' || !value.key.trim()) throw new Error();
      this.deps.secrets.setSecret(TOKEN_DANCE.secretId, value.key.trim());
    } catch {
      throw new Error(controller.signal.aborted ? 'TokenDance 授权已取消或超时。' : 'TokenDance 授权失败，请重新连接。');
    } finally {
      clearTimeout(timer); server.close(); server.closeAllConnections();
      if (this.cancelAuthorization === cancel) this.cancelAuthorization = undefined;
    }
  }

  async runtimeProfile(profile: ProviderProfile): Promise<ProviderProfile> {
    if (!this.connected) throw new Error('请先在 Claude 模型设置中连接 TokenDance。');
    if (Date.now() - this.catalogTime > 5 * 60_000) await this.refreshCatalog();
    const model = profile.defaultModel || profile.model;
    if (!this.catalog.some(item => item.id === model)) throw new Error(`TokenDance 模型 ${model} 当前不可用，请刷新模型目录。`);
    await this.start();
    return { ...profile, baseUrl: this.gatewayUrl, apiKey: this.gatewayToken, anthropicAuthMode: 'authToken' };
  }

  private async start(): Promise<void> {
    if (this.closed) throw new Error('TokenDance 服务已关闭。');
    if (this.starting) return this.starting;
    if (this.gateway?.listening) return;
    this.starting = (async () => {
      const server = createServer((request, response) => { void this.handleRequest(request, response); });
      this.gateway = server;
      server.requestTimeout = 120_000;
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      if (this.closed) { server.close(); throw new Error('TokenDance 服务已关闭。'); }
      this.gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    })();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!equalToken(request.headers.authorization ?? request.headers['x-api-key'], this.gatewayToken)) {
      json(response, 401, { error: { message: '无效的本机 TokenDance 凭据。' } }); return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname)) {
      json(response, 404, { error: { message: '不支持此接口。' } }); return;
    }
    const controller = new AbortController();
    this.requests.add(controller);
    response.on('close', () => controller.abort());
    const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) { json(response, 413, { error: { message: '请求过大。' } }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (Date.now() - this.catalogTime > 5 * 60_000) await this.refreshCatalog();
      const model = this.catalog.find(item => item.id === body.model);
      if (!model) { json(response, 400, { error: { message: '该模型不在 TokenDance 可用目录中。' } }); return; }
      const key = this.readKey();
      if (!key) { json(response, 401, { error: { message: '请重新连接 TokenDance。' } }); return; }
      const native = model.supportedProtocols.includes(TOKEN_DANCE.messages);
      if (!native && url.pathname.endsWith('/count_tokens')) {
        // OpenAI has no count_tokens endpoint. Conservative local estimate for CLI budgeting only.
        const estimate = Math.ceil(Buffer.byteLength(JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools })) / 2);
        json(response, 200, { input_tokens: Math.max(1, estimate) }); return;
      }
      const upstreamBody = native ? body : anthropicToOpenAI(body);
      const upstream = await this.request(`${TOKEN_DANCE.baseUrl}${native ? url.pathname : '/v1/chat/completions'}`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`,
          ...(native ? { 'anthropic-version': '2023-06-01' } : {}) },
        body: JSON.stringify(upstreamBody),
      });
      const status = upstream.statusCode ?? 502;
      if (status < 200 || status >= 300) {
        const recovery = upstream.headers['tokendance-recovery-action'];
        upstream.destroy();
        json(response, status, { type: 'error', error: { type: 'api_error', message: tokenDanceError(status, typeof recovery === 'string' ? recovery : null) } });
        return;
      }
      if (native) {
        response.writeHead(status, { 'Content-Type': upstream.headers['content-type'] ?? 'application/json', 'Cache-Control': 'no-store' });
        await pipeline(upstream, response, { signal: controller.signal });
      } else if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        await pipeChatAsMessages(upstream, response, model.id, controller.signal);
      } else {
        const value = await readTokenDanceJson(upstream);
        if (!value || typeof value !== 'object' || !('choices' in value) || !Array.isArray(value.choices) || !value.choices.length) throw new Error();
        json(response, 200, openAIToAnthropic(value));
      }
    } catch {
      const error = { type: 'api_error', message: 'TokenDance 请求或协议转换失败，请重试；兼容模式支持文本、图片和工具调用。' };
      if (!response.headersSent) json(response, 502, { type: 'error', error });
      else if (!response.destroyed) response.end(formatSSEEvent('error', { type: 'error', error }));
    } finally { clearTimeout(timeout); this.requests.delete(controller); }
  }

  async test(profile: ProviderProfile): Promise<void> {
    const runtime = await this.runtimeProfile(profile);
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await this.request(`${runtime.baseUrl}/v1/messages`, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${runtime.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: runtime.defaultModel, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
      });
      const value = await readTokenDanceJson(response) as { type?: string; content?: unknown[]; error?: { message?: string } };
      if (response.statusCode !== 200) throw new Error(value.error?.message ?? tokenDanceError(response.statusCode ?? 502));
      if (value.type !== 'message' || !Array.isArray(value.content) || !value.content.length) throw new Error('TokenDance 未返回有效消息。');
    } finally { clearTimeout(timer); this.requests.delete(controller); }
  }

  close(): void {
    this.closed = true;
    this.cancel();
    for (const controller of this.requests) controller.abort();
    this.gateway?.close(); this.gateway?.closeAllConnections();
    this.gateway = undefined; this.gatewayUrl = '';
  }
}
