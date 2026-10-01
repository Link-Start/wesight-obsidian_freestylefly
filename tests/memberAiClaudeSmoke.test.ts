import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from 'node:timers';
import { managedProjection } from '../src/memberAi/projection';
import { MemberAiService } from '../src/memberAi/service';
import { tokenDanceRequest } from '../src/tokendance/transport';
import type { CloudAuthService } from '../src/share/cloudAuth';

// Opt-in real CLI, entirely fake loopback model. No platform credentials/cost.
test.skipIf(!process.env.WESIGHT_TEST_CLAUDE_BINARY)(
  'real Claude honors managed routing over project credentials',
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wesight-member-cli-test-'));
    let calls = 0;
    const paths: string[] = [];
    const outputLimits: number[] = [];
    let service: MemberAiService | undefined;
    let validToken = true;
    let leaked = false;
    const server = createServer((req, res) => {
      void (async () => {
        paths.push(req.url ?? '');
        const chunks: Buffer[] = [];
        for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
        const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { max_tokens?: number };
        chunks.length = 0;
        if (metadata.max_tokens) outputLimits.push(metadata.max_tokens);
        if (req.url?.startsWith('/v1/messages/count_tokens')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"input_tokens":100}');
          return;
        }
        if (!req.url?.startsWith('/v1/messages')) {
          res.writeHead(404);
          res.end();
          return;
        }
        calls++;
        validToken &&= req.headers.authorization === 'Bearer private-test-wesight-login';
        leaked ||= req.headers['x-api-key'] === 'personal-test-key';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const events = [
          {
            type: 'message_start',
            message: {
              id: 'msg_test',
              type: 'message',
              role: 'assistant',
              model: 'deepseek-v4.1-flash',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LOCAL_MEMBER_OK' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 4 },
          },
          { type: 'message_stop' },
        ];
        res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
      })().catch(() => res.destroy());
    });
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      await fs.mkdir(path.join(dir, '.claude'));
      await fs.writeFile(
        path.join(dir, '.claude', 'settings.json'),
        JSON.stringify({
          env: {
            ANTHROPIC_API_KEY: 'personal-test-key',
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
            CLAUDE_CODE_USE_BEDROCK: '1',
          },
        }),
      );
      service = new MemberAiService({
        auth: {
          getCurrentUser: () => ({ userId: 'test-user' }) as ReturnType<CloudAuthService['getCurrentUser']>,
          getAccessToken: async () => 'private-test-wesight-login',
          refreshAccessToken: async () => 'private-test-wesight-login',
          onChange: () => () => {},
        },
        confirmDisclosure: async () => true,
        request: async (url, options) => {
          if (url.endsWith('/status')) {
            const res = Readable.from([
              Buffer.from(
                JSON.stringify({
                  code: 0,
                  data: {
                    state: 'ready',
                    membership: { active: true, expiresAt: null },
                    quota: { remainingPercent: 100, resetsAt: null },
                    models: [{ id: 'deepseek-v4.1-flash', name: 'Flash' }],
                    defaultModel: 'deepseek-v4.1-flash',
                    gatewayUrl: 'https://ai-gateway.canghecode.com',
                  },
                }),
              ),
            ]) as IncomingMessage;
            res.statusCode = 200;
            res.headers = { 'content-type': 'application/json' };
            return res;
          }
          return tokenDanceRequest(`${baseUrl}${new URL(url).pathname}`, options);
        },
      });
      const profile = await service.runtimeProfile();
      const projection = managedProjection(profile, process.env);
      const child = spawn(
        process.env.WESIGHT_TEST_CLAUDE_BINARY!,
        [
          '-p',
          '--output-format',
          'json',
          '--model',
          profile.model,
          '--tools',
          '',
          '--no-session-persistence',
          '--max-turns',
          '1',
          '--setting-sources',
          'project,local',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          ...projection.args,
        ],
        { cwd: dir, env: projection.env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.resume();
      child.stdin.end('Reply LOCAL_MEMBER_OK only.');
      const timeout = scheduleTimeout(() => child.kill('SIGKILL'), 30000);
      try {
        const [code] = (await once(child, 'exit')) as [number | null, string | null];
        expect(code).toBe(0);
      } finally {
        cancelTimeout(timeout);
      }
      expect(output).toContain('LOCAL_MEMBER_OK');
      expect(calls).toBeGreaterThan(0);
      expect(outputLimits.every((limit) => limit > 0 && limit <= 32768)).toBe(true);
      expect(
        paths
          .filter((url) => url.startsWith('/v1/messages'))
          .every((url) => ['/v1/messages', '/v1/messages/count_tokens'].includes(url)),
      ).toBe(true);
      expect(validToken).toBe(true);
      expect(leaked).toBe(false);
    } finally {
      service?.close();
      server.closeAllConnections();
      server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  40000,
);
