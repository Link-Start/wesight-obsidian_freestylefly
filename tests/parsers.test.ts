import { createClaudeStreamParser, parseClaudeStreamLine, parseCodexStreamLine, parseOpenCodeStreamLine } from '../src/runtime/parsers';

describe('Claude turn stream reconciliation', () => {
  const start = (id: string) => ({
    type: 'stream_event', event: { type: 'message_start', message: { id } },
  });
  const delta = (type: 'text' | 'thinking', value: string) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: `${type}_delta`, [type]: value } },
  });
  const snapshot = (id: string, text: string, thinking?: string) => ({
    type: 'assistant',
    message: {
      id, role: 'assistant',
      content: [
        ...(thinking ? [{ type: 'thinking', thinking }] : []),
        { type: 'text', text },
      ],
    },
  });
  const parseSequence = (records: unknown[]) => {
    const parse = createClaudeStreamParser();
    return records.flatMap(record => parse(JSON.stringify(record)));
  };

  test('emits streamed text and thinking once when the assistant snapshot arrives', () => {
    expect(parseSequence([
      start('m1'), delta('thinking', '分析'), delta('text', '你好'),
      delta('text', ' '), delta('text', '世界'),
      snapshot('m1', '你好 世界', '分析'),
      { type: 'result', subtype: 'success', result: '你好 世界' },
    ])).toEqual([
      { type: 'reasoning', content: '分析' },
      { type: 'text', content: '你好' },
      { type: 'text', content: ' ' },
      { type: 'text', content: '世界' },
    ]);
  });

  test('recovers unstreamed text and thinking from the snapshot', () => {
    expect(parseSequence([
      start('m1'), delta('text', 'hello'), snapshot('m1', 'hello world', 'plan'),
    ])).toEqual([
      { type: 'text', content: 'hello' },
      { type: 'reasoning', content: 'plan' },
      { type: 'text', content: ' world' },
    ]);
  });

  test('preserves repeated deltas and identical text in separate messages', () => {
    expect(parseSequence([
      start('m1'), delta('text', 'ha'), delta('text', 'ha'), snapshot('m1', 'haha'),
      start('m2'), delta('text', 'haha'), snapshot('m2', 'haha'),
      snapshot('m3', 'haha'),
    ])).toEqual([
      { type: 'text', content: 'ha' }, { type: 'text', content: 'ha' },
      { type: 'text', content: 'haha' }, { type: 'text', content: 'haha' },
    ]);
  });

  test('handles complete messages without partial events and ignores snapshot replays by ID', () => {
    expect(parseSequence([
      snapshot('m1', 'hello'), snapshot('m1', 'hello'), snapshot('m2', 'hello'),
    ])).toEqual([{ type: 'text', content: 'hello' }, { type: 'text', content: 'hello' }]);
  });

  test('reconciles separate block snapshots sharing a message ID', () => {
    expect(parseSequence([
      start('m1'), delta('text', 'first'), snapshot('m1', 'first'),
      delta('text', 'second'), snapshot('m1', 'second'), snapshot('m1', 'second'),
      delta('text', 'second'), snapshot('m1', 'second'),
      snapshot('m1', 'firstsecondsecond'),
    ])).toEqual([
      { type: 'text', content: 'first' },
      { type: 'text', content: 'second' },
      { type: 'text', content: 'second' },
    ]);
  });

  test('keeps separate parser instances independent', () => {
    const first = createClaudeStreamParser();
    const second = createClaudeStreamParser();
    first(JSON.stringify(start('m1')));
    first(JSON.stringify(delta('text', 'hello')));
    expect(first(JSON.stringify(snapshot('m1', 'hello')))).toEqual([]);
    expect(second(JSON.stringify(snapshot('m1', 'hello')))).toEqual([{ type: 'text', content: 'hello' }]);
  });
});

describe('stream parsers', () => {
  test('parses Claude assistant message content arrays', () => {
    const events = parseClaudeStreamLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello' }],
      },
    }));
    expect(events).toContainEqual({ type: 'text', content: 'hello' });
  });

  test('parses Claude nested content block deltas', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '<section>' },
      },
    }))).toContainEqual({ type: 'text', content: '<section>' });
  });

  test('preserves whitespace-only Claude text deltas', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: ' ' },
      },
    }))).toEqual([{ type: 'text', content: ' ' }]);
  });

  test('ignores Claude tool results that contain HTML examples', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          content: '<section><p>Skill 组件示例</p></section>',
        }],
      },
    }))).toEqual([]);
  });

  test('keeps assistant text while ignoring non-text content blocks', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_result', content: '<section>工具输出</section>' },
          { type: 'text', text: '<section>正文</section>' },
        ],
      },
    }))).toEqual([{ type: 'text', content: '<section>正文</section>' }]);
  });

  test('parses Claude result errors', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'API Error: Request rejected (429)',
    }))).toContainEqual({ type: 'error', message: 'API Error: Request rejected (429)' });
  });

  test('parses Codex deltas and errors', () => {
    expect(parseCodexStreamLine(JSON.stringify({
      type: 'item.agent_message.delta',
      delta: 'hi',
    }))).toContainEqual({ type: 'text', content: 'hi' });
    expect(parseCodexStreamLine(JSON.stringify({
      type: 'turn.failed',
      message: 'bad model',
    }))).toContainEqual({ type: 'error', message: 'bad model' });
  });

  test('parses Codex item.completed agent messages', () => {
    expect(parseCodexStreamLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'OK' },
    }))).toContainEqual({ type: 'text', content: 'OK' });
    expect(parseCodexStreamLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'message', content: [{ type: 'output_text', text: 'hi there' }] },
    }))).toContainEqual({ type: 'text', content: 'hi there' });
  });

  test('parses Claude thinking content blocks', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think' },
          { type: 'text', text: 'hello' },
        ],
      },
    }))).toEqual([
      { type: 'reasoning', content: 'Let me think' },
      { type: 'text', content: 'hello' },
    ]);
  });

  test('parses Claude thinking deltas', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'step 1' },
      },
    }))).toContainEqual({ type: 'reasoning', content: 'step 1' });
  });

  test('parses Codex thinking items', () => {
    expect(parseCodexStreamLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'thinking', text: 'planning' },
    }))).toContainEqual({ type: 'reasoning', content: 'planning' });
    expect(parseCodexStreamLine(JSON.stringify({
      type: 'item.agent_message.delta',
      reasoning: 'reasoning delta',
    }))).toContainEqual({ type: 'reasoning', content: 'reasoning delta' });
  });

  test('parses OpenCode text payloads', () => {
    expect(parseOpenCodeStreamLine(JSON.stringify({
      type: 'message',
      text: 'done',
    }))).toContainEqual({ type: 'text', content: 'done' });
    expect(parseOpenCodeStreamLine(JSON.stringify({
      type: 'part.updated',
      part: { type: 'text', text: '<section>' },
    }))).toContainEqual({ type: 'text', content: '<section>' });
  });
});
