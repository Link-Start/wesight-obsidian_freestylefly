import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import type { CloudAuthService } from '../share/cloudAuth';
import type { ProviderProfile } from '../types';
import { readTokenDanceJson, tokenDanceRequest } from '../tokendance/transport';
import { EMPTY_MEMBER_AI_STATUS, MEMBER_AI_MESSAGES, type MemberAiStatus } from './types';
import { MemberRequestIdentity } from './requestIdentity';

interface Dependencies {
  auth: Pick<CloudAuthService, 'getCurrentUser' | 'getAccessToken' | 'refreshAccessToken' | 'onChange'>;
  confirmDisclosure: (userId: string) => Promise<boolean>;
  request?: typeof tokenDanceRequest;
}
export function memberGatewayUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('会员模型网关尚未配置');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'ai-gateway.canghecode.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('会员模型网关配置无效');
  return url.origin;
}
export class MemberAiService {
  status: MemberAiStatus = { ...EMPTY_MEMBER_AI_STATUS };
  private listeners = new Set<() => void>();
  private server?: Server;
  private startPromise?: Promise<void>;
  private refreshPromise?: Promise<MemberAiStatus>;
  private token = randomBytes(32).toString('base64url');
  private url = '';
  private controllers = new Set<AbortController>();
  private stopped = false;
  private generation = 0;
  private unsubscribe: () => void;
  private readonly request: typeof tokenDanceRequest;
  private consentPromise?: Promise<boolean>;
  private identities = new MemberRequestIdentity();
  constructor(private deps: Dependencies) {
    this.request = deps.request ?? tokenDanceRequest;
    let userId = deps.auth.getCurrentUser()?.userId;
    this.unsubscribe = deps.auth.onChange(() => {
      const next = deps.auth.getCurrentUser()?.userId;
      if (next === userId) {
        void this.refresh();
        return;
      }
      userId = next;
      this.generation++;
      for (const c of this.controllers) c.abort();
      this.token = randomBytes(32).toString('base64url');
      this.identities.clear();
      this.status = { ...EMPTY_MEMBER_AI_STATUS, state: deps.auth.getCurrentUser() ? 'checking' : 'login-required' };
      this.emit();
      void this.refresh();
    });
  }
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }
  async refresh(): Promise<MemberAiStatus> {
    if (this.stopped) return this.status;
    if (this.refreshPromise) return this.refreshPromise;
    if (!this.deps.auth.getCurrentUser()) {
      this.status = { ...EMPTY_MEMBER_AI_STATUS, state: 'login-required' };
      this.emit();
      return this.status;
    }
    const generation = this.generation;
    this.refreshPromise = (async () => {
      const c = new AbortController();
      this.controllers.add(c);
      const timer = setTimeout(() => c.abort(), 15000);
      try {
        const res = await this.authorized('https://api.wesight.ai/api/member-ai/status', { signal: c.signal });
        const data = (await readTokenDanceJson(res)) as { code: number; data: MemberAiStatus };
        if (res.statusCode !== 200 || data.code !== 0 || !data.data || !Array.isArray(data.data.models))
          throw new Error();
        if (data.data.gatewayUrl) memberGatewayUrl(data.data.gatewayUrl);
        if (!Object.hasOwn(MEMBER_AI_MESSAGES, data.data.state) || !data.data.quota || !data.data.membership)
          throw new Error();
        if (generation === this.generation) this.status = data.data;
      } catch {
        if (generation === this.generation)
          this.status = {
            ...EMPTY_MEMBER_AI_STATUS,
            state: this.deps.auth.getCurrentUser() ? 'unavailable' : 'login-required',
          };
      } finally {
        clearTimeout(timer);
        this.controllers.delete(c);
        this.refreshPromise = undefined;
        this.emit();
        if (generation !== this.generation) void this.refresh();
      }
      return this.status;
    })();
    return this.refreshPromise;
  }
  async requireReady(model?: string): Promise<string> {
    const generation = this.generation;
    const state = await this.refresh();
    if (state.state !== 'ready') throw new Error(MEMBER_AI_MESSAGES[state.state]);
    const selected = model || state.defaultModel;
    if (!state.models.some((m) => m.id === selected)) throw new Error('所选会员模型已停用，请重新选择。');
    const user = this.deps.auth.getCurrentUser();
    if (!user) throw new Error(MEMBER_AI_MESSAGES['login-required']);
    this.consentPromise ??= this.deps.confirmDisclosure(user.userId);
    let allowed: boolean;
    try {
      allowed = await this.consentPromise;
    } finally {
      this.consentPromise = undefined;
    }
    if (!allowed) throw new Error('已取消发送，消息尚未传给模型服务。');
    if (generation !== this.generation || this.stopped) throw new Error('账户状态已改变，请重新发送。');
    return selected;
  }
  async runtimeProfile(model?: string): Promise<ProviderProfile> {
    const generation = this.generation;
    const selected = await this.requireReady(model);
    await this.start();
    if (generation !== this.generation || this.stopped) throw new Error('账户状态已改变，请重新发送。');
    return {
      id: 'wesight-managed',
      agentId: 'claude',
      name: 'WeSight 会员模型',
      apiKey: this.token,
      baseUrl: this.url,
      model: selected,
      defaultModel: selected,
      models: this.status.models.map((m) => m.id),
      wireApi: 'chat',
      anthropicAuthMode: 'authToken',
      isDefault: true,
      createdAt: 0,
      updatedAt: 0,
    };
  }
  private async authorized(url: string, options: Parameters<typeof tokenDanceRequest>[1] = {}) {
    const generation = this.generation;
    const send = async () => {
      const accessToken = await this.deps.auth.getAccessToken();
      if (generation !== this.generation || this.stopped || !accessToken) throw new Error('账户状态已改变');
      return this.request(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${accessToken}` } });
    };
    let result = await send();
    if (result.statusCode === 401) {
      result.destroy();
      await this.deps.auth.refreshAccessToken();
      result = await send();
    }
    return result;
  }
  private async start(): Promise<void> {
    if (this.stopped) throw new Error('会员模型服务已关闭');
    if (this.server?.listening) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      this.server = createServer((req, res) => {
        const token = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /i, ''));
        const expected = Buffer.from(this.token);
        const json = (status: number, message: string) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
        };
        if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
          json(401, '本机凭据已失效');
          return;
        }
        const pathname = (req.url ?? '').split('?')[0];
        if (req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(pathname)) {
          json(404, '接口不可用');
          return;
        }
        const c = new AbortController();
        this.controllers.add(c);
        res.on('close', () => c.abort());
        const timer = setTimeout(() => c.abort(), 10 * 60_000);
        void (async () => {
          try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req as AsyncIterable<Buffer>) {
              size += chunk.length;
              if (size > 1024 * 1024) {
                json(413, '上下文过大，请减少附件');
                return;
              }
              chunks.push(Buffer.from(chunk));
            }
            const origin = memberGatewayUrl(this.status.gatewayUrl);
            const body = Buffer.concat(chunks);
            if (c.signal.aborted) throw new Error('请求已取消');
            const requestId = this.identities.resolve(body, req.headers);
            const upstream = await this.authorized(`${origin}${pathname}`, {
              method: 'POST',
              signal: c.signal,
              headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
              body: body.toString('utf8'),
            });
            if (upstream.statusCode !== 200) {
              const status = upstream.statusCode ?? 502;
              upstream.destroy();
              json(
                status,
                status === 402
                  ? MEMBER_AI_MESSAGES['quota-exhausted']
                  : status === 403
                    ? '请开通或续费会员'
                    : status === 429
                      ? '请求较多，请稍后重试'
                      : '会员模型请求失败，请刷新状态后重试',
              );
              return;
            }
            res.writeHead(200, {
              'Content-Type': upstream.headers['content-type'] ?? 'application/json',
              'Cache-Control': 'no-store',
            });
            await pipeline(upstream, res, { signal: c.signal });
          } catch {
            if (!res.headersSent) json(503, '会员模型网络连接失败，请稍后重试');
            else if (!res.destroyed) res.destroy();
          } finally {
            clearTimeout(timer);
            this.controllers.delete(c);
            void this.refresh();
          }
        })();
      });
      this.server.listen(0, '127.0.0.1');
      await once(this.server, 'listening');
      if (this.stopped) {
        this.server.close();
        throw new Error('会员模型服务已关闭');
      }
      this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    })();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }
  close(): void {
    this.stopped = true;
    this.unsubscribe();
    for (const c of this.controllers) c.abort();
    this.server?.close();
    this.server?.closeAllConnections();
    this.listeners.clear();
  }
}
