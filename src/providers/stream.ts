import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { formatSSEEvent, mapStopReason, type OpenAIStreamChunk } from './format';

/** Translate text/thinking deltas and assemble interleaved tool arguments losslessly. */
export async function pipeChatAsMessages(upstream: IncomingMessage, response: ServerResponse, model: string, signal?: AbortSignal, providerName = '模型服务'): Promise<void> {
  let index = -1;
  let active: 'text' | 'thinking' | null = null;
  let finish: string | null = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  const tools = new Map<number, { id: string; name: string; arguments: string }>();
  const emit = (event: string, data: Record<string, unknown>): void => {
    response.write(formatSSEEvent(event, { type: event, ...data }));
  };
  const closeBlock = (): void => {
    if (active) emit('content_block_stop', { index });
    active = null;
  };
  const delta = (type: 'text' | 'thinking', value: string): void => {
    if (active !== type) {
      closeBlock();
      index++;
      active = type;
      emit('content_block_start', { index, content_block: { type, [type]: '' } });
    }
    emit('content_block_delta', { index, delta: { type: `${type}_delta`, [type]: value } });
  };
  emit('message_start', {
    message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null, usage },
  });
  const processPacket = (packet: string): void => {
    const data = packet.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const chunk = JSON.parse(data) as OpenAIStreamChunk & { error?: unknown };
    if (chunk.error) throw new Error(`${providerName} 流式响应失败。`);
    if (chunk.usage) usage = {
      input_tokens: chunk.usage.prompt_tokens ?? usage.input_tokens,
      output_tokens: chunk.usage.completion_tokens ?? usage.output_tokens,
    };
    const choice = chunk.choices?.[0];
    const content = choice?.delta;
    const thinking = content?.reasoning_content ?? content?.reasoning;
    if (thinking) delta('thinking', thinking);
    if (content?.content) delta('text', content.content);
    for (const call of content?.tool_calls ?? []) {
      const toolIndex = call.index ?? 0;
      const tool = tools.get(toolIndex) ?? { id: '', name: '', arguments: '' };
      if (call.id) tool.id = call.id;
      if (call.function?.name) tool.name += call.function.name;
      tool.arguments += call.function?.arguments ?? '';
      if (tool.arguments.length > 8 * 1024 * 1024 || tools.size > 128) throw new Error('工具响应超出大小限制。');
      tools.set(toolIndex, tool);
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
  };
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (): void => {
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      processPacket(buffer.slice(0, boundary.index).replace(/\r\n/g, '\n'));
      buffer = buffer.slice(boundary.index + boundary[0].length);
    }
    if (buffer.length > 16 * 1024 * 1024) throw new Error(`${providerName} 流式事件超出大小限制。`);
  };
  for await (const chunk of upstream as AsyncIterable<Buffer>) {
    buffer += decoder.decode(Buffer.from(chunk), { stream: true });
    consume();
    if (response.writableNeedDrain) await once(response, 'drain', { signal });
  }
  buffer += decoder.decode();
  consume();
  if (buffer.trim()) processPacket(buffer.replace(/\r\n/g, '\n'));
  if (!finish) throw new Error(`${providerName} 响应中断，请重试。`);
  closeBlock();
  for (const tool of tools.values()) {
    if (!tool.id || !tool.name) throw new Error(`${providerName} 返回了不完整的工具调用。`);
    // Validate before emitting tool_use; malformed arguments must never execute as {}.
    JSON.parse(tool.arguments || '{}');
    index++;
    emit('content_block_start', { index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
    emit('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: tool.arguments || '{}' } });
    emit('content_block_stop', { index });
  }
  emit('message_delta', { delta: { stop_reason: mapStopReason(finish), stop_sequence: null }, usage });
  emit('message_stop', {});
  response.end();
}
