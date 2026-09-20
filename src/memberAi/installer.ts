import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from 'node:timers';
import { tokenDanceRequest } from '../tokendance/transport';
import { RuntimeDiscovery, invalidateRuntimeDiscoveryCache } from '../runtime/discovery';
import type { WeSightObsidianSettings } from '../types';

export type InstallState = 'idle' | 'downloading' | 'installing' | 'verifying' | 'ready' | 'cancelled' | 'error';
export function officialInstallSpec(platform: NodeJS.Platform, arch: string) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch))
    throw new Error('当前平台不支持一键安装，请使用官方安装指南。');
  return platform === 'win32'
    ? { url: 'https://claude.ai/install.ps1', shell: 'powershell.exe', suffix: '.ps1' }
    : { url: 'https://claude.ai/install.sh', shell: 'bash', suffix: '.sh' };
}
export async function downloadOfficialInstaller(url: string, signal: AbortSignal): Promise<Buffer> {
  for (let redirects = 0; redirects < 4; redirects++) {
    const target = new URL(url);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.port ||
      target.search ||
      target.hash ||
      ![
        'https://claude.ai/install.sh',
        'https://claude.ai/install.ps1',
        'https://downloads.claude.ai/claude-code-releases/bootstrap.sh',
        'https://downloads.claude.ai/claude-code-releases/bootstrap.ps1',
      ].includes(target.href)
    )
      throw new Error('非官方安装地址');
    const response = await tokenDanceRequest(url, { signal });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      const next = response.headers.location;
      response.destroy();
      if (!next) throw new Error();
      url = new URL(next, url).href;
      continue;
    }
    if (response.statusCode !== 200) {
      response.destroy();
      throw new Error();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of response as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error();
        chunks.push(chunk);
      }
    } finally {
      response.destroy();
    }
    if (!size) throw new Error();
    return Buffer.concat(chunks);
  }
  throw new Error('官方安装重定向次数过多');
}
export class ClaudeInstaller {
  state: InstallState = 'idle';
  message = '';
  private child?: ChildProcess;
  private abort?: AbortController;
  private running = false;
  private listeners = new Set<() => void>();
  constructor(
    private getSettings: () => WeSightObsidianSettings,
    private save: () => Promise<void>,
  ) {}
  get busy(): boolean {
    return this.running;
  }
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private update(state: InstallState, message: string): void {
    this.state = state;
    this.message = message;
    for (const fn of this.listeners) fn();
  }
  cancel(): void {
    this.abort?.abort();
    if (this.child?.pid) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true });
        killer.on('error', () => {});
      } else {
        try {
          process.kill(-this.child.pid, 'SIGTERM');
        } catch {
          this.child.kill('SIGTERM');
        }
      }
    }
    if (this.busy) this.update(this.state, '正在取消安装…');
  }
  async install(): Promise<void> {
    if (this.busy) return;
    this.running = true;
    const settings = this.getSettings();
    const existing = new RuntimeDiscovery({ configuredPaths: settings.configuredPaths }).resolve('claude', {
      withVersion: true,
    });
    if (existing.found) {
      this.running = false;
      this.update('ready', '已发现 Claude Code，继续使用现有安装。');
      return;
    }
    const controller = new AbortController();
    this.abort = controller;
    let dir: string | undefined;
    const timeout = scheduleTimeout(() => this.cancel(), 10 * 60_000);
    try {
      const spec = officialInstallSpec(process.platform, process.arch);
      this.update('downloading', '正在从 Claude 官方下载安装程序…');
      const bytes = await downloadOfficialInstaller(spec.url, controller.signal);
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wesight-claude-install-'));
      const script = path.join(dir, `install${spec.suffix}`);
      await fs.writeFile(script, bytes, { mode: 0o600 });
      if (controller.signal.aborted) throw new Error();
      this.update('installing', '正在安装 Claude Code 稳定版，请稍候…');
      await new Promise<void>((resolve, reject) => {
        if (controller.signal.aborted) {
          reject(new Error());
          return;
        }
        let failed = false;
        this.child = spawn(
          spec.shell,
          process.platform === 'win32'
            ? ['-NoProfile', '-NonInteractive', '-File', script, 'stable']
            : [script, 'stable'],
          { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' },
        );
        this.child.once('error', () => {
          failed = true;
        });
        this.child.once('close', (code) => (code === 0 && !failed ? resolve() : reject(new Error())));
      });
      if (controller.signal.aborted) throw new Error();
      this.update('verifying', '正在检测 Claude Code 安装结果…');
      invalidateRuntimeDiscoveryCache('claude');
      const binary = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
      const discovered = new RuntimeDiscovery({
        configuredPaths: { ...settings.configuredPaths, claude: binary },
      }).resolve('claude', { withVersion: true });
      if (!discovered.found || !discovered.version) throw new Error();
      settings.configuredPaths.claude = discovered.binaryPath!;
      await this.save();
      this.update('ready', `Claude Code 已就绪：${discovered.version}`);
    } catch {
      this.update(
        controller.signal.aborted ? 'cancelled' : 'error',
        controller.signal.aborted
          ? '安装已取消，可重试。'
          : '官方安装未完成，请检查网络、系统权限后重试，或打开官方安装指南。',
      );
    } finally {
      cancelTimeout(timeout);
      this.child = undefined;
      this.abort = undefined;
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      this.running = false;
      this.update(this.state, this.message);
    }
  }
}
