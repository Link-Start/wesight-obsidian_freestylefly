import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { OpenLuxService } from '../src/openlux/service';
import { OPEN_LUX } from '../src/openlux/constants';
import { parseOpenLuxCatalog, getModelVendor, groupModelsByVendor, mergeCatalogModels } from '../src/openlux/catalog';
import { providerRequest } from '../src/providers/transport';
import { prepareProviderProjection } from '../src/runtime/providerProjection';
import type { ProviderProfile } from '../src/types';

function profile(model = 'google/gemini-2.5-pro', key = 'upstream-secret'): ProviderProfile {
  return { id: key, providerKey: 'openlux', agentId: 'claude', name: 'OpenLux', apiKey: key,
    baseUrl: OPEN_LUX.baseUrl, model, defaultModel: model, models: [model], wireApi: 'chat',
    isDefault: true, createdAt: 1, updatedAt: 1 };
}

function reply(value: unknown, status = 200): IncomingMessage {
  const response = Readable.from([Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]) as IncomingMessage;
  response.statusCode = status;
  response.headers = { 'content-type': 'application/json' };
  return response;
}

const services: OpenLuxService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
const completion = { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } };
function setup(upstream: typeof providerRequest = async () => reply(completion)) {
  const request = vi.fn<typeof providerRequest>(async (url, options) => url.startsWith('http://127.0.0.1') ? providerRequest(url, options) : upstream(url, options));
  const service = new OpenLuxService(request);
  services.push(service);
  return { service, request };
}

async function post(runtime: ProviderProfile, body: unknown, path = '/v1/messages') {
  return fetch(`${runtime.baseUrl}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${runtime.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const message = (model: string, stream = false) => ({ model, stream, max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] });

test('catalog preserves exact IDs, deduplicates, filters media and classifies misleading owners', () => {
  const rows = parseOpenLuxCatalog({ data: [
    { id: 'google/gemini-2.5-pro', name: 'Gemini Pro', owned_by: 'openai', supports_image: true },
    { id: 'claude-sonnet-4', owned_by: 'openai' }, { id: 'gpt-4o' }, { id: 'gpt-4o' },
    { id: 'custom-chat', owned_by: 'mistralai' }, { id: 'unknown-chat' }, { id: '' }, null,
    ...['gpt-image-1', 'gemini-3-pro-image-preview', 'embedding-v2', 'veo-3', 'suno', 'whisper', 'tts', 'rerank', 'flux', 'seedream-4', 'gpt-audio', 'gpt-4o-audio-preview', 'gpt-realtime', 'bge-m3', 'nomic-embed-text'].map(id => ({ id })),
  ] });
  expect(rows.map(row => row.id)).toEqual(['google/gemini-2.5-pro', 'claude-sonnet-4', 'gpt-4o', 'custom-chat', 'unknown-chat']);
  expect(rows.map(getModelVendor)).toEqual(['google', 'anthropic', 'openai', 'mistral', 'other']);
  expect(rows[0]).toMatchObject({ name: 'Gemini Pro', supportsImage: true });
  expect(rows[2].supportsImage).toBeUndefined();
  expect(groupModelsByVendor(rows).map(group => group.vendor)).toEqual(['openai', 'google', 'anthropic', 'mistral', 'other']);
  expect(groupModelsByVendor(rows, 'GEMINI')[0].models).toEqual([rows[0]]);
  expect(groupModelsByVendor(rows, 'no match')).toEqual([]);
  expect(() => parseOpenLuxCatalog({ models: [] })).toThrow('目录格式无效');
  expect(parseOpenLuxCatalog({ data: [] })).toEqual([]);
});

test('refresh keeps custom names and manually added models', () => {
  expect(mergeCatalogModels([{ id: 'gpt-4o', name: 'GPT', modelVendor: 'openai', supportsImage: true }], [
    { id: 'gpt-4o', name: 'My GPT' }, { id: 'manual-chat', name: 'Manual' },
  ])).toEqual([{ id: 'gpt-4o', name: 'My GPT', modelVendor: 'openai', supportsImage: true }, { id: 'manual-chat', name: 'Manual' }]);
  expect(mergeCatalogModels([{ id: 'gpt-4o', name: 'GPT', supportsImage: false }], [
    { id: 'gpt-4o', name: 'My GPT', supportsImage: true },
  ])[0].supportsImage).toBe(false);
  expect(mergeCatalogModels([{ id: 'unknown', name: 'Unknown' }], [])[0].supportsImage).toBeUndefined();
});

test('catalog requests use Bearer auth and normalize root and v1 URLs', async () => {
  const { service, request } = setup(async () => reply({ data: [{ id: 'gpt-4o' }] }));
  for (const baseUrl of ['https://api.openlux.ai', `${OPEN_LUX.baseUrl}/`]) {
    expect(await service.fetchCatalog({ baseUrl, apiKey: 'catalog-key' })).toHaveLength(1);
    expect(request).toHaveBeenLastCalledWith(`${OPEN_LUX.baseUrl}/models`, expect.objectContaining({ headers: { Authorization: 'Bearer catalog-key' } }));
  }
  await expect(service.fetchCatalog({ baseUrl: OPEN_LUX.baseUrl, apiKey: '' })).rejects.toThrow('API Key');
});

test('Claude receives only loopback credentials; full IDs, images and tools reach the configured relay', async () => {
  const { service, request } = setup();
  const original = profile();
  const lease = await service.acquire(original);
  const projection = prepareProviderProjection('claude', lease.profile, { ANTHROPIC_API_KEY: 'old-key' });
  expect(projection.env.ANTHROPIC_AUTH_TOKEN).not.toBe(original.apiKey);
  expect(projection.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(projection.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
  const result = await post(lease.profile, {
    ...message(original.model), system: 'System',
    tools: [{ name: 'read', input_schema: { type: 'object', properties: { file: { type: 'string' } } } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: { file: 'note' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'result' }] }],
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'OK' }] });
  const [url, init] = request.mock.calls[0];
  expect(url).toBe(`${OPEN_LUX.baseUrl}/chat/completions`);
  expect(init?.headers?.Authorization).toBe('Bearer upstream-secret');
  const body = JSON.parse(init!.body!) as Record<string, unknown>;
  expect(body.model).toBe(original.model);
  expect(JSON.stringify(body)).toContain('data:image/png;base64,aGVsbG8=');
  expect(JSON.stringify(body)).toContain('tool_call_id');
  expect(body.tools).toEqual([expect.objectContaining({ type: 'function' })]);
  lease.release();
  expect((await post(lease.profile, message(original.model))).status).toBe(401);
});

test('concurrent sessions bind separate keys and model snapshots', async () => {
  const { service, request } = setup();
  const a = profile('gpt-4o', 'key-a');
  const b = profile('gemini-2.5-pro', 'key-b');
  const [first, second] = await Promise.all([service.acquire(a), service.acquire(b)]);
  a.apiKey = 'changed-key'; a.models.push('intruder');
  await Promise.all([post(first.profile, message('gpt-4o')), post(second.profile, message('gemini-2.5-pro'))]);
  expect(request.mock.calls.map(([, init]) => init?.headers?.Authorization).sort()).toEqual(['Bearer key-a', 'Bearer key-b']);
  expect((await post(first.profile, message('gemini-2.5-pro'))).status).toBe(400);
  expect((await post(first.profile, message('intruder'))).status).toBe(400);
  first.release();
  expect((await post(second.profile, message('gemini-2.5-pro'))).status).toBe(200);
});

test('token counting stays local and malformed bodies or paths never reach upstream', async () => {
  const { service, request } = setup();
  const { profile: runtime } = await service.acquire(profile());
  const count = await post(runtime, message(runtime.model), '/v1/messages/count_tokens');
  expect((await count.json() as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
  expect((await post(runtime, [], '/v1/messages')).status).toBe(400);
  expect((await post(runtime, {}, '/other')).status).toBe(404);
  expect(request).not.toHaveBeenCalled();
});

test.each([401, 403, 402, 429, 500])('upstream %s preserves status and hides private error bodies', async status => {
  const { service } = setup(async () => reply({ error: 'private upstream-secret detail' }, status));
  const lease = await service.acquire(profile());
  const result = await post(lease.profile, message(lease.profile.model));
  expect(result.status).toBe(status);
  const text = await result.text();
  expect(text).toContain('OpenLux');
  expect(text).not.toContain('upstream-secret');
  expect(text).not.toContain('private');
});

test('streaming assembles interleaved tool calls and emits reasoning, usage and a valid terminal event', async () => {
  const packets = [
    { choices: [{ delta: { reasoning_content: 'Think', content: 'Text', tool_calls: [{ index: 0, id: 'call-a', function: { name: 'read', arguments: '{"file":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call-b', function: { name: 'write', arguments: '{"text":"OK"}' } }, { index: 0, function: { arguments: '"note"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 7 } },
  ];
  const { service } = setup(async () => reply(packets.map(packet => `data: ${JSON.stringify(packet)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n'));
  const lease = await service.acquire(profile());
  const result = await post(lease.profile, message(lease.profile.model, true));
  expect(result.headers.get('content-type')).toBe('text/event-stream');
  const text = await result.text();
  expect(text).toContain('thinking_delta'); expect(text).toContain('text_delta');
  expect(text).toContain('call-a'); expect(text).toContain('call-b');
  expect(text).toContain('"stop_reason":"tool_use"');
  expect(text).toContain('"output_tokens":7');
  expect(text).toContain('event: message_stop');
});

test('invalid streaming tool arguments terminate with an error before tools are emitted', async () => {
  const packet = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad', function: { name: 'read', arguments: '{bad' } }] }, finish_reason: 'tool_calls' }] };
  const { service } = setup(async () => reply(`data: ${JSON.stringify(packet)}\n\n`));
  const lease = await service.acquire(profile());
  const text = await (await post(lease.profile, message(lease.profile.model, true))).text();
  expect(text).toContain('event: error');
  expect(text).not.toContain('"type":"tool_use"');
  expect(text).not.toContain('event: message_stop');
});

test('abort invalidates one lease and aborts its outstanding upstream request', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let upstreamSignal: AbortSignal | undefined;
  const { service } = setup(async (_url, init) => new Promise((_resolve, reject) => {
    upstreamSignal = init?.signal;
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    started();
  }));
  const controller = new AbortController();
  const lease = await service.acquire(profile(), controller.signal);
  const pending = post(lease.profile, message(lease.profile.model));
  await ready;
  controller.abort();
  expect(upstreamSignal?.aborted).toBe(true);
  expect((await pending).status).toBe(502);
  expect((await post(lease.profile, message(lease.profile.model))).status).toBe(401);
});

test('connection test follows the proxy and validates a returned message', async () => {
  const { service, request } = setup();
  await service.test(profile());
  expect(request.mock.calls.map(([url]) => url)).toEqual([expect.stringContaining('/v1/messages'), `${OPEN_LUX.baseUrl}/chat/completions`]);
  const bad = setup(async () => reply({ choices: [] }));
  await expect(bad.service.test(profile())).rejects.toThrow('OpenLux');
  await expect(service.acquire({ ...profile(), agentId: 'opencode' })).rejects.toThrow('仅支持 Claude Code');
  service.close();
  await expect(service.acquire(profile())).rejects.toThrow('已关闭');
});

test.each([{ choices: [] }, { choices: [{}] }, { choices: [{ message: { content: null } }] }])('invalid non-streaming responses fail without fabricating a message: %j', async value => {
  const { service } = setup(async () => reply(value));
  const lease = await service.acquire(profile());
  const response = await post(lease.profile, message(lease.profile.model));
  expect(response.status).toBe(502);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ type: 'error' });
  expect(JSON.stringify(body)).toContain('OpenLux');
});
