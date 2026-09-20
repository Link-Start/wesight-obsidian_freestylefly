import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { ClaudeInstaller, officialInstallSpec, downloadOfficialInstaller } from '../src/memberAi/installer';
import { DEFAULT_SETTINGS } from '../src/types';
import { tokenDanceRequest } from '../src/tokendance/transport';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), spawn: vi.fn() }));
vi.mock('../src/runtime/discovery', () => ({
  RuntimeDiscovery: class {
    resolve(...args: unknown[]): unknown {
      return mocks.resolve(...args) as unknown;
    }
  },
  invalidateRuntimeDiscoveryCache: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../src/tokendance/transport', () => ({ tokenDanceRequest: vi.fn() }));
function response(value = 'official-test-script', status = 200, location?: string): IncomingMessage {
  const res = Readable.from([Buffer.from(value)]) as IncomingMessage;
  res.statusCode = status;
  res.headers = { location };
  return res;
}
const settings = () => ({ ...DEFAULT_SETTINGS, configuredPaths: { ...DEFAULT_SETTINGS.configuredPaths } });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockReturnValue({ found: false });
  vi.mocked(tokenDanceRequest).mockImplementation(async () => response());
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
});
describe('official Claude installation', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'selects the official installer for %s without elevation',
    (platform) => {
      const spec = officialInstallSpec(platform, 'arm64');
      expect(spec.url).toMatch(/^https:\/\/claude.ai\/install\.(sh|ps1)$/);
      expect(spec.shell).toBe(platform === 'win32' ? 'powershell.exe' : 'bash');
    },
  );
  it('rejects unsupported platforms/architectures', () => {
    expect(() => officialInstallSpec('freebsd', 'x64')).toThrow('不支持');
    expect(() => officialInstallSpec('linux', 'ia32')).toThrow('不支持');
  });
  it('reuses an existing executable without downloading or spawning', async () => {
    mocks.resolve.mockReturnValue({ found: true, version: 'Claude Code 2.1' });
    const installer = new ClaudeInstaller(settings, vi.fn());
    await installer.install();
    expect(installer.state).toBe('ready');
    expect(tokenDanceRequest).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('follows the observed official bootstrap redirect only', async () => {
    vi.mocked(tokenDanceRequest).mockResolvedValueOnce(
      response('', 302, 'https://downloads.claude.ai/claude-code-releases/bootstrap.sh'),
    );
    expect(
      (await downloadOfficialInstaller('https://claude.ai/install.sh', new AbortController().signal)).toString(),
    ).toBe('official-test-script');
    vi.mocked(tokenDanceRequest).mockResolvedValueOnce(response('', 302, 'https://evil.example/install.sh'));
    await expect(
      downloadOfficialInstaller('https://claude.ai/install.sh', new AbortController().signal),
    ).rejects.toThrow('非官方');
  });
  it('bounds script size and rejects empty or failed downloads', async () => {
    for (const value of ['', 'x'.repeat(1024 * 1024 + 1)]) {
      vi.mocked(tokenDanceRequest).mockResolvedValueOnce(response(value));
      await expect(
        downloadOfficialInstaller('https://claude.ai/install.sh', new AbortController().signal),
      ).rejects.toThrow();
    }
    vi.mocked(tokenDanceRequest).mockResolvedValueOnce(response('denied', 403));
    await expect(
      downloadOfficialInstaller('https://claude.ai/install.sh', new AbortController().signal),
    ).rejects.toThrow();
  });
  it('detects the installed path/version and persists it without PATH changes', async () => {
    const config = settings();
    const save = vi.fn(async () => {});
    mocks.resolve
      .mockReturnValueOnce({ found: false })
      .mockReturnValueOnce({ found: true, binaryPath: '/test/claude', version: 'Claude Code 2.1' });
    const installer = new ClaudeInstaller(() => config, save);
    await installer.install();
    expect(installer.state).toBe('ready');
    expect(config.configuredPaths.claude).toBe('/test/claude');
    expect(save).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.spawn.mock.calls)).not.toMatch(/sudo|ExecutionPolicy|Bypass/);
  });
  it('keeps busy until cancellation finishes and allows a clean retry', async () => {
    vi.mocked(tokenDanceRequest).mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => queueMicrotask(() => reject(new Error('aborted'))), {
            once: true,
          });
        }),
    );
    const installer = new ClaudeInstaller(settings, vi.fn());
    const first = installer.install();
    installer.cancel();
    await installer.install();
    expect(tokenDanceRequest).toHaveBeenCalledOnce();
    await first;
    expect(installer.state).toBe('cancelled');
    expect(installer.busy).toBe(false);
    mocks.resolve.mockReturnValue({ found: true });
    await installer.install();
    expect(installer.state).toBe('ready');
  });
  it('network or verification failures remain retryable and do not save invalid paths', async () => {
    const save = vi.fn();
    const installer = new ClaudeInstaller(settings, save);
    vi.mocked(tokenDanceRequest).mockRejectedValueOnce(new Error('network secret URL'));
    await installer.install();
    expect(installer.state).toBe('error');
    expect(installer.message).not.toContain('secret');
    await installer.install();
    expect(installer.state).toBe('error');
    expect(save).not.toHaveBeenCalled();
    expect(installer.busy).toBe(false);
  });
});
