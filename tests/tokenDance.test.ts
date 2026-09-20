import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOKEN_DANCE, TOKEN_DANCE_MODEL_IDS, parseTokenDanceCatalog } from '../src/tokendance/catalog';
import { TokenDanceService } from '../src/tokendance/service';
import { tokenDanceRequest } from '../src/tokendance/transport';
import { anthropicToOpenAI } from '../src/tokendance/format';
import { ProviderStore } from '../src/storage/providerStore';
import { prepareProviderProjection } from '../src/runtime/providerProjection';
import type { ProviderProfile } from '../src/types';

// Node's test runner exercises the actual loopback listener.
const fetchLoopback = globalThis.fetch;

const catalog = { data: TOKEN_DANCE_MODEL_IDS.map((id, index) => ({
  id, supported_protocols: index < 4
    ? ['anthropic:messages', 'openai:chat-completions'] : ['openai:chat-completions', 'openai:responses'],
})) };
const upstreamSecret = 'test-oauth-upstream-secret';

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): IncomingMessage {
  const response = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as IncomingMessage;
  response.statusCode = status;
  response.headers = { 'content-type': 'application/json', ...headers };
  return response;
}

function profile(model: string = TOKEN_DANCE_MODEL_IDS[0]): ProviderProfile {
  return { id: 'tokendance', name: TOKEN_DANCE.name, agentId: 'claude', apiKey: TOKEN_DANCE.credentialRef,
    baseUrl: TOKEN_DANCE.baseUrl, model, defaultModel: model, models: [...TOKEN_DANCE_MODEL_IDS],
    isDefault: true, wireApi: 'chat', anthropicAuthMode: 'authToken', createdAt: 1, updatedAt: 1 };
}

const services: TokenDanceService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });

function setup(options: {
  upstream?: (url: string, options: Parameters<typeof tokenDanceRequest>[1]) => IncomingMessage;
  openExternal?: (url: string) => void | Promise<void>;
  timeout?: number;
  connected?: boolean;
} = {}) {
  const secrets = new Map<string, string>(options.connected === false ? [] : [[TOKEN_DANCE.secretId, upstreamSecret]]);
  const secretStorage = { getSecret: (key: string) => secrets.get(key) ?? null,
    setSecret: (key: string, value: string) => { secrets.set(key, value); } };
  const request = vi.fn<typeof tokenDanceRequest>(async (url, init) => {
    if (url.startsWith('http://127.0.0.1')) return tokenDanceRequest(url, init);
    if (url === TOKEN_DANCE.catalogUrl) return reply(catalog);
    if (options.upstream) return options.upstream(url, init);
    return reply({ type: 'message', content: [{ type: 'text', text: 'OK' }] });
  });
  const service = new TokenDanceService({ secrets: secretStorage, request,
    openExternal: options.openExternal ?? (() => {}), authorizationTimeoutMs: options.timeout });
  services.push(service);
  return { service, request, secrets, secretStorage };
}

async function post(runtime: ProviderProfile, body: unknown, endpoint = '/v1/messages') {
  return fetchLoopback(`${runtime.baseUrl}${endpoint}`, { method: 'POST',
    headers: { Authorization: `Bearer ${runtime.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('matches exact IDs in requested order and retains live protocol changes', () => {
  const rows = parseTokenDanceCatalog({ data: [...[...catalog.data].reverse(), { id: 'glm-5.3-flashx', supported_protocols: ['anthropic:messages'] }] });
  expect(rows.map(model => model.id)).toEqual(TOKEN_DANCE_MODEL_IDS);
  expect(rows[4].supportedProtocols).not.toContain(TOKEN_DANCE.messages);
  expect(parseTokenDanceCatalog({ data: [{ id: 'kimi-k3', supported_protocols: ['embeddings'] }] })).toEqual([]);
  expect(() => parseTokenDanceCatalog({ models: [] })).toThrow();
});

test('OAuth uses S256, unguessable loopback callback, and stores only exchanged key', async () => {
  let challenge = '';
  const { service, request, secrets } = setup({ connected: false,
    openExternal: async value => {
      const url = new URL(value);
      expect(url.origin).toBe(TOKEN_DANCE.origin);
      expect(url.pathname).toBe('/auth');
      expect(url.searchParams.get('app_url')).toBe('https://wesight.ai');
      expect(url.searchParams.get('key_name')).toBe('WeSight Obsidian');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(value).not.toContain(upstreamSecret);
      challenge = url.searchParams.get('code_challenge')!;
      const callback = new URL(url.searchParams.get('callback_url')!);
      expect(callback.hostname).toBe('127.0.0.1');
      expect(callback.pathname).toMatch(/^\/callback\/[a-f0-9]{48}$/);
      expect((await fetchLoopback(`${callback.origin}/callback/wrong?code=attacker`)).status).toBe(404);
      expect((await fetchLoopback(callback)).status).toBe(400);
      callback.searchParams.set('code', 'test-code');
      const result = await fetchLoopback(callback);
      expect(result.status).toBe(200);
      expect(result.headers.get('referrer-policy')).toBe('no-referrer');
    },
    upstream: (url, init) => {
      expect(url).toBe(TOKEN_DANCE.exchangeUrl);
      const body = JSON.parse(init!.body!) as { code: string; code_challenge_method: string; code_verifier: string };
      expect(body.code).toBe('test-code');
      expect(body.code_challenge_method).toBe('S256');
      expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(challenge);
      return reply({ key: upstreamSecret });
    },
  });
  await service.authorize();
  expect(service.connected).toBe(true);
  expect(service.authorizing).toBe(false);
  expect(secrets.get(TOKEN_DANCE.secretId)).toBe(upstreamSecret);
  expect(request).toHaveBeenCalledTimes(1);
});

test('cancel and timeout settle authorization without saving a key', async () => {
  const cancelled = setup({ connected: false, openExternal: () => { cancelled.service.cancel(); } });
  await expect(cancelled.service.authorize()).rejects.toThrow('取消或超时');
  expect(cancelled.service.connected).toBe(false);
  const timedOut = setup({ connected: false, timeout: 20 });
  await expect(timedOut.service.authorize()).rejects.toThrow('取消或超时');
  expect(timedOut.service.authorizing).toBe(false);
});

test('failed exchange redacts upstream responses and preserves previous authorization', async () => {
  const { service, secrets } = setup({
    openExternal: async value => { await fetchLoopback(`${new URL(value).searchParams.get('callback_url')}?code=bad`); },
    upstream: () => reply({ key: 'must-not-save', error: upstreamSecret }, 403),
  });
  await expect(service.authorize()).rejects.toThrow('授权失败');
  expect(secrets.get(TOKEN_DANCE.secretId)).toBe(upstreamSecret);
});

test('runtime rejects missing auth and absent models and fails closed on catalog errors', async () => {
  await expect(setup({ connected: false }).service.runtimeProfile(profile())).rejects.toThrow('连接 TokenDance');
  const { service, request } = setup();
  await expect(service.runtimeProfile(profile('not-a-model'))).rejects.toThrow('当前不可用');
  request.mockResolvedValueOnce(reply({}, 503));
  await expect(service.refreshCatalog()).rejects.toThrow('实时模型目录');
});

test.each(TOKEN_DANCE_MODEL_IDS.slice(0, 4))('native Messages forwards %s with upstream key isolated', async model => {
  const { service, request } = setup();
  const runtime = await service.runtimeProfile(profile(model));
  expect(runtime.apiKey).not.toBe(upstreamSecret);
  const env = prepareProviderProjection('claude', runtime, {}).env;
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe(runtime.apiKey);
  expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127.0.0.1:/);
  const body = { model, stream: false, max_tokens: 64, messages: [{ role: 'user', content: 'OK' }] };
  expect((await post(runtime, body)).status).toBe(200);
  const upstream = request.mock.calls.find(([url]) => url.endsWith('/gateway/v1/messages'))!;
  expect(upstream[1]?.headers?.Authorization).toBe(`Bearer ${upstreamSecret}`);
  expect(JSON.parse(upstream[1]!.body!)).toEqual(body);
});

test.each(['kimi-k3', 'hy4-preview'])('bridges %s through chat/completions with tool round trips', async model => {
  const { service, request } = setup({ upstream: () => reply({ id: 'chat-1', model,
    choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
      { id: 'tool-1', function: { name: 'Read', arguments: '{"path":"note.md"}' } },
    ] } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }) });
  const runtime = await service.runtimeProfile(profile(model));
  const result = await post(runtime, { model, max_tokens: 128, messages: [{ role: 'user', content: 'Read note' }],
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'Read', disable_parallel_tool_use: true } });
  const payload = await result.json() as { stop_reason: string; content: Array<Record<string, unknown>> };
  expect(payload.stop_reason).toBe('tool_use');
  expect(payload.content[0]).toMatchObject({ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'note.md' } });
  const call = request.mock.calls.find(([url]) => url.endsWith('/gateway/v1/chat/completions'))!;
  const converted = JSON.parse(call[1]!.body!) as Record<string, unknown>;
  expect(converted.tool_choice).toEqual({ type: 'function', function: { name: 'Read' } });
  expect(converted.parallel_tool_calls).toBe(false);
  const roundTrip = anthropicToOpenAI({ messages: [
    { role: 'assistant', content: payload.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file content' }] },
  ] });
  expect(roundTrip.messages).toMatchObject([
    { role: 'assistant', tool_calls: [{ id: 'tool-1', function: { arguments: '{"path":"note.md"}' } }] },
    { role: 'tool', tool_call_id: 'tool-1', content: 'file content' },
  ]);
});

test('stream preserves fragmented UTF-8, reasoning, parallel tools and final usage', async () => {
  const chunks = [
    { choices: [{ delta: { reasoning_content: '思考' } }] },
    { choices: [{ delta: { content: '你好' } }] },
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'tool-a', function: { name: 'Read', arguments: '{"path":' } },
      { index: 1, id: 'tool-b', function: { name: 'Glob', arguments: '{"pattern":' } },
    ] } }] },
    { choices: [{ delta: { tool_calls: [
      { index: 1, function: { arguments: '"*.md"}' } },
      { index: 0, function: { arguments: '"中文.md"}' } },
    ] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
  ];
  const wire = Buffer.from(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
  const { service } = setup({ upstream: () => {
    const response = Readable.from(Array.from(wire, byte => Buffer.from([byte]))) as IncomingMessage;
    response.statusCode = 200; response.headers = { 'content-type': 'text/event-stream' }; return response;
  } });
  const runtime = await service.runtimeProfile(profile('kimi-k3'));
  const result = await post(runtime, { model: 'kimi-k3', stream: true, messages: [] });
  const text = await result.text();
  expect(text).toContain('思考'); expect(text).toContain('你好'); expect(text).toContain('中文.md');
  const events = text.split('\n\n').filter(Boolean).map(packet => JSON.parse(packet.split('\ndata: ')[1]) as { type: string; content_block?: { type: string } });
  expect(events.filter(event => event.type === 'content_block_start').map(event => event.content_block?.type)).toEqual(['thinking', 'text', 'tool_use', 'tool_use']);
  expect(events.at(-2)).toMatchObject({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 100, output_tokens: 20 } });
  expect(events.at(-1)?.type).toBe('message_stop');
});

test('truncated streams and invalid tool JSON end with errors, never successful message_stop', async () => {
  for (const chunk of [
    { choices: [{ delta: { content: 'partial' } }] },
    { choices: [{ delta: { tool_calls: [{ id: 'tool-1', function: { name: 'Read', arguments: '{' } }] }, finish_reason: 'tool_calls' }] },
  ]) {
    const { service } = setup({ upstream: () => reply(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`) });
    const runtime = await service.runtimeProfile(profile('kimi-k3'));
    const result = await post(runtime, { model: 'kimi-k3', stream: true, messages: [] });
    const text = await result.text();
    expect(text).toContain('event: error');
    expect(text).not.toContain('message_stop');
  }
});

test('gateway restricts credentials, paths, models and sanitizes recovery errors', async () => {
  const { service } = setup({ upstream: () => reply({ error: upstreamSecret }, 402, { 'tokendance-recovery-action': 'top_up_balance' }) });
  const runtime = await service.runtimeProfile(profile());
  expect((await post({ ...runtime, apiKey: 'wrong' }, {})).status).toBe(401);
  expect((await post(runtime, {}, '/v1/responses')).status).toBe(404);
  expect((await post(runtime, { model: 'glm-5.3-flashx' })).status).toBe(400);
  const result = await post(runtime, { model: runtime.model, messages: [] });
  expect(result.status).toBe(402);
  const text = await result.text();
  expect(text).toContain('余额不足'); expect(text).not.toContain(upstreamSecret);
  service.disconnect();
  expect(service.connected).toBe(false);
  expect((await post(runtime, {})).status).toBe(401);
});

test('native SSE is unchanged and compatibility token count is a local estimate', async () => {
  const wire = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const { service, request } = setup({ upstream: () => reply(wire, 200, { 'content-type': 'text/event-stream' }) });
  const runtime = await service.runtimeProfile(profile());
  expect(await (await post(runtime, { model: runtime.model, stream: true })).text()).toBe(wire);
  const before = request.mock.calls.length;
  const counted = await post(runtime, { model: 'hy4-preview', messages: [{ role: 'user', content: '你好' }] }, '/v1/messages/count_tokens');
  expect(((await counted.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
  expect(request.mock.calls.length).toBe(before);
});

test('saved profile, exported config and Claude environment never contain OAuth API key', async () => {
  const { service, secretStorage } = setup();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-tokendance-test-'));
  try {
    const store = new ProviderStore(secretStorage, { WESIGHT_HOME: tempDir });
    const saved = store.save(profile());
    const runtime = await service.runtimeProfile(saved);
    const projection = prepareProviderProjection('claude', runtime, { ANTHROPIC_API_KEY: 'old' });
    expect(projection.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(projection.env)).not.toContain(upstreamSecret);
    expect(JSON.stringify(store.exportProfiles({ includeSecrets: true }))).not.toContain(upstreamSecret);
    expect(fs.readFileSync(store.path, 'utf8')).not.toContain(upstreamSecret);
    await service.test(saved);
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
});
