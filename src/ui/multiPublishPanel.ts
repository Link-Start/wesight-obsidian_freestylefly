import { App, Notice, setIcon, TFile } from 'obsidian';

import { MultiPublishBridge } from '../multiPublish/bridge';
import {
  MULTI_PUBLISH_FREE_LIMIT_NOTICE,
  MULTI_PUBLISH_LOGIN_PROMPT,
  normalizeMultiPublishSelection,
  resolveMultiPublishAccess,
  validateMultiPublishTargetCount,
} from '../multiPublish/access';
import {
  CHROME_EXTENSION_DOWNLOAD_URL,
  CHROME_EXTENSIONS_URL,
  CHROME_INSTALL_STEPS,
} from '../multiPublish/installGuide';
import { buildMultiPublishSnapshot } from '../multiPublish/snapshot';
import {
  MULTI_PLATFORM_IDS,
  type MultiPlatformId,
  type MultiPublishSelectablePlatformId,
  type MultiPlatformTaskState,
  type MultiPublishSnapshot,
  type MultiPublishTaskState,
} from '../multiPublish/types';
import type { CloudAuthService } from '../share/cloudAuth';
import type { WeSightObsidianSettings } from '../types';

const PLATFORM_COPY: Record<MultiPublishSelectablePlatformId, { label: string; description: string; titleLimit: number; url: string }> = {
  zhihu: { label: '知乎', description: '专栏富文本草稿', titleLimit: 100, url: 'https://zhuanlan.zhihu.com/write' },
  csdn: { label: 'CSDN', description: '博客编辑器草稿', titleLimit: 100, url: 'https://mp.csdn.net/mp_blog/creation/editor' },
  juejin: { label: '掘金', description: 'Markdown 文章草稿', titleLimit: 80, url: 'https://juejin.cn/editor/drafts/new?v=2' },
  'bilibili-article': { label: 'B站专栏', description: '专栏编辑页草稿', titleLimit: 40, url: 'https://member.bilibili.com/article-text/home?newEditor=-1' },
  toutiao: { label: '今日头条', description: '图文编辑页草稿', titleLimit: 30, url: 'https://mp.toutiao.com/profile_v4/graphic/publish' },
  'weibo-article': { label: '微博头条文章', description: '头条文章草稿', titleLimit: 32, url: 'https://card.weibo.com/article/v5/editor' },
};

const STATUS_COPY: Record<MultiPlatformTaskState['status'], string> = {
  queued: '等待中',
  opening: '打开中',
  login_required: '需要登录',
  filling: '填充中',
  ready: '等待发布',
  failed: '失败',
  cancelled: '已取消',
};

interface MultiPublishPanelOptions {
  app: App;
  auth: CloudAuthService;
  bridge: MultiPublishBridge;
  file: TFile;
  getSettings: () => WeSightObsidianSettings;
  saveSettings: () => Promise<void>;
  requestRender: () => void;
  requestPosition: () => void;
}

export class MultiPublishPanel {
  private snapshot: MultiPublishSnapshot | null = null;
  private task: MultiPublishTaskState | null = null;
  private loading = false;
  private busy = false;
  private authLoading = false;
  private authChecked = false;
  private loginPending = false;
  private error = '';
  private loadVersion = 0;
  private installGuideDismissed = false;
  private unsubscribe: (() => void) | null = null;
  private selected = new Set<MultiPublishSelectablePlatformId>();
  private selectionLimitNotified = false;

  constructor(private readonly options: MultiPublishPanelOptions) {
    const saved = options.getSettings().multiPublishPlatforms;
    this.selected = new Set(MULTI_PLATFORM_IDS.filter(platformId => saved.includes(platformId)));
  }

  activate(force = false): void {
    if (!this.unsubscribe) {
      this.unsubscribe = this.options.bridge.onChange(() => {
        if (this.task) this.task = this.options.bridge.getTask(this.task.taskId) ?? this.task;
        this.options.requestRender();
      });
    }
    if (!this.task) {
      const latest = this.options.bridge.getLatestTask();
      if (latest?.targets.every(platformId => MULTI_PLATFORM_IDS.includes(platformId as MultiPublishSelectablePlatformId))) {
        this.task = latest;
      }
    }
    if (force || !this.snapshot) void this.load();
    if (!this.authChecked || !this.options.auth.getCurrentUser() || !this.options.auth.getBillingSummary()) {
      void this.refreshAccess();
    }
  }

  dispose(): void {
    this.loadVersion += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  render(parent: HTMLElement): void {
    if (this.loading) {
      const loading = parent.createDiv({ cls: 'wesight-multi-loading' });
      const icon = loading.createSpan();
      setIcon(icon, 'loader-circle');
      loading.createSpan({ text: '正在准备多平台快照…' });
      return;
    }
    if (this.error && !this.snapshot) {
      this.renderError(parent);
      return;
    }
    if (!this.snapshot) {
      parent.createDiv({ cls: 'wesight-share-error', text: '无法读取当前文章。' });
      return;
    }

    this.renderArticle(parent, this.snapshot);
    if (this.authLoading) {
      this.renderAuthLoading(parent);
      return;
    }
    if (!this.options.auth.getCurrentUser()) {
      this.renderLogin(parent);
      return;
    }
    const connection = this.options.bridge.getConnectionState();
    if (!connection.paired && !this.installGuideDismissed) {
      this.renderInstallGuide(parent);
      if (this.error) this.renderError(parent);
      return;
    }
    this.renderConnection(parent);
    if (this.task) this.renderTask(parent, this.task);
    else this.renderSelection(parent, this.snapshot);
    if (this.error) this.renderError(parent);
  }

  private async load(): Promise<void> {
    const version = ++this.loadVersion;
    this.loading = true;
    this.error = '';
    this.options.requestRender();
    try {
      const snapshot = await buildMultiPublishSnapshot(this.options.app, this.options.file);
      if (version !== this.loadVersion) return;
      this.snapshot = snapshot;
    } catch (error) {
      if (version === this.loadVersion) this.error = error instanceof Error ? error.message : '多平台快照生成失败';
    } finally {
      if (version === this.loadVersion) {
        this.loading = false;
        this.options.requestRender();
        this.options.requestPosition();
      }
    }
  }

  private renderArticle(parent: HTMLElement, snapshot: MultiPublishSnapshot): void {
    const article = parent.createDiv({ cls: 'wesight-multi-article' });
    const icon = article.createDiv({ cls: 'wesight-multi-article-icon' });
    setIcon(icon, 'file-text');
    const copy = article.createDiv();
    copy.createSpan({ text: '当前文章' });
    copy.createEl('strong', { text: snapshot.title });
  }

  private renderAuthLoading(parent: HTMLElement): void {
    const loading = parent.createDiv({ cls: 'wesight-multi-loading is-auth' });
    const icon = loading.createSpan();
    setIcon(icon, 'loader-circle');
    loading.createSpan({ text: '正在检查 WeSight 登录与会员状态…' });
  }

  private renderLogin(parent: HTMLElement): void {
    const gate = parent.createDiv({ cls: 'wesight-multi-login-gate' });
    const heading = gate.createDiv({ cls: 'wesight-multi-login-heading' });
    const headingIcon = heading.createSpan();
    setIcon(headingIcon, 'log-in');
    const copy = heading.createDiv();
    copy.createEl('strong', { text: '登录后使用平台同步' });
    copy.createSpan({ text: '普通用户可同步 1 个平台，WeSight 会员可一次同步多个平台。' });
    const login = gate.createEl('button', {
      cls: 'wesight-share-primary-button is-multi',
      text: this.loginPending ? '等待登录完成' : '请先登录 WeSight',
      attr: { type: 'button' },
    });
    login.disabled = this.loginPending;
    login.onclick = () => {
      this.loginPending = true;
      this.options.auth.startLogin();
      this.options.requestRender();
    };
    const privacy = gate.createDiv({ cls: 'wesight-share-privacy-note' });
    const privacyIcon = privacy.createSpan();
    setIcon(privacyIcon, 'shield-check');
    privacy.createSpan({ text: '登录仅用于确认账号与会员状态，文章仍通过本机临时通道传输。' });
  }

  private async refreshAccess(): Promise<void> {
    if (this.authLoading) return;
    this.authLoading = true;
    this.options.requestRender();
    try {
      const user = await this.options.auth.restoreSession();
      if (user) {
        await this.options.auth.refreshBillingSummary(false).catch(() => null);
      }
      if (user) this.loginPending = false;
      await this.enforceSelectionLimit();
    } finally {
      this.authChecked = true;
      this.authLoading = false;
      this.options.requestRender();
      this.options.requestPosition();
    }
  }

  private async enforceSelectionLimit(): Promise<void> {
    const access = resolveMultiPublishAccess(
      this.options.auth.getCurrentUser(),
      this.options.auth.getBillingSummary(),
    );
    const ordered = MULTI_PLATFORM_IDS.filter(platformId => this.selected.has(platformId));
    const normalized = normalizeMultiPublishSelection(access, ordered);
    if (!normalized.limited) return;
    this.selected = new Set(normalized.platforms.filter(
      (platformId): platformId is MultiPublishSelectablePlatformId => platformId !== 'xiaohongshu',
    ));
    await this.persistSelection();
    if (!this.selectionLimitNotified) {
      this.selectionLimitNotified = true;
      new Notice(MULTI_PUBLISH_FREE_LIMIT_NOTICE);
    }
  }

  private renderInstallGuide(parent: HTMLElement): void {
    const guide = parent.createDiv({ cls: 'wesight-multi-install-guide' });
    const heading = guide.createDiv({ cls: 'wesight-multi-install-heading' });
    const headingIcon = heading.createSpan();
    setIcon(headingIcon, 'puzzle');
    const headingCopy = heading.createDiv();
    headingCopy.createEl('strong', { text: '首次使用，先安装浏览器插件' });
    headingCopy.createSpan({ text: '只需安装一次，扩展会复用浏览器中已有的平台登录状态。' });

    const steps = guide.createDiv({ cls: 'wesight-multi-install-steps' });
    CHROME_INSTALL_STEPS.forEach((step, index) => {
      const row = steps.createDiv({ cls: 'wesight-multi-install-step' });
      row.createSpan({ cls: 'wesight-multi-install-number', text: String(index + 1) });
      const copy = row.createDiv({ cls: 'wesight-multi-install-copy' });
      copy.createEl('strong', { text: step.title });
      copy.createSpan({ text: step.description });
      if (index === 0) {
        const download = row.createEl('button', {
          cls: 'wesight-multi-install-action',
          text: '下载插件',
          attr: { type: 'button' },
        });
        const icon = download.createSpan();
        setIcon(icon, 'download');
        download.prepend(icon);
        download.onclick = () => window.open(CHROME_EXTENSION_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
      }
      if (index === 2) {
        const open = row.createEl('button', {
          cls: 'wesight-multi-install-action',
          text: '打开安装页',
          attr: { type: 'button' },
        });
        const icon = open.createSpan();
        setIcon(icon, 'external-link');
        open.prepend(icon);
        open.onclick = () => void this.openChromeExtensions();
      }
    });

    const continueButton = guide.createEl('button', {
      cls: 'wesight-share-primary-button is-multi wesight-multi-install-continue',
      text: '我已安装，继续选择平台',
      attr: { type: 'button' },
    });
    const continueIcon = continueButton.createSpan();
    setIcon(continueIcon, 'circle-check');
    continueButton.prepend(continueIcon);
    continueButton.onclick = () => {
      this.installGuideDismissed = true;
      this.options.requestRender();
      this.options.requestPosition();
    };
    guide.createSpan({
      cls: 'wesight-multi-install-footnote',
      text: '安装完成后，首次发布任务会自动完成本机配对。',
    });
  }

  private async openChromeExtensions(): Promise<void> {
    try {
      await navigator.clipboard.writeText(CHROME_EXTENSIONS_URL);
    } catch {
      // Direct navigation may still work when clipboard access is unavailable.
    }
    window.open(CHROME_EXTENSIONS_URL, '_blank', 'noopener,noreferrer');
    new Notice('已尝试打开扩展程序管理页面；如果没有跳转，请粘贴已复制的地址。');
  }

  private renderConnection(parent: HTMLElement): void {
    const state = this.options.bridge.getConnectionState();
    const row = parent.createDiv({ cls: `wesight-multi-connection${state.connected ? ' is-connected' : ''}` });
    const icon = row.createSpan();
    setIcon(icon, state.connected ? 'link' : state.paired ? 'radio' : 'plug-zap');
    const copy = row.createDiv();
    copy.createEl('strong', {
      text: state.connected ? '浏览器扩展已连接' : state.paired ? '扩展已配对，等待连接' : '首次任务将完成扩展配对',
    });
    copy.createSpan({ text: '正文与图片只通过 127.0.0.1 临时通道传输' });
    if (state.paired && !this.task) {
      const repair = row.createEl('button', {
        cls: 'wesight-multi-link-button',
        text: '重新配对',
        attr: { type: 'button' },
      });
      repair.disabled = this.busy;
      repair.onclick = () => void this.start(true);
    }
  }

  private renderSelection(parent: HTMLElement, snapshot: MultiPublishSnapshot): void {
    const heading = parent.createDiv({ cls: 'wesight-multi-section-heading' });
    const headingCopy = heading.createDiv({ cls: 'wesight-multi-section-title' });
    headingCopy.createEl('strong', { text: '选择发布平台' });
    const access = resolveMultiPublishAccess(
      this.options.auth.getCurrentUser(),
      this.options.auth.getBillingSummary(),
    );
    headingCopy.createSpan({
      text: access.state === 'multi-platform' ? 'WeSight 会员 · 支持多选' : '普通用户 · 最多 1 个平台',
    });
    const allSelected = this.selected.size === MULTI_PLATFORM_IDS.length;
    const selectAll = heading.createEl('button', {
      cls: 'wesight-multi-link-button',
      text: allSelected ? '取消全选' : '全选',
      attr: { type: 'button' },
    });
    selectAll.onclick = () => {
      if (!allSelected) {
        const accessError = validateMultiPublishTargetCount(access, MULTI_PLATFORM_IDS.length);
        if (accessError) {
          new Notice(accessError);
          return;
        }
      }
      this.selected = allSelected ? new Set() : new Set(MULTI_PLATFORM_IDS);
      void this.persistSelection();
      this.options.requestRender();
    };

    const grid = parent.createDiv({ cls: 'wesight-multi-platform-grid' });
    for (const platformId of MULTI_PLATFORM_IDS) {
      const selected = this.selected.has(platformId);
      const card = grid.createEl('label', { cls: `wesight-multi-platform${selected ? ' is-selected' : ''}` });
      const checkbox = card.createEl('input', { attr: { type: 'checkbox' } });
      checkbox.checked = selected;
      checkbox.onchange = () => {
        if (checkbox.checked) {
          const proposedCount = selected ? this.selected.size : this.selected.size + 1;
          const accessError = validateMultiPublishTargetCount(access, proposedCount);
          if (accessError) {
            checkbox.checked = false;
            new Notice(accessError);
            return;
          }
          this.selected.add(platformId);
        } else {
          this.selected.delete(platformId);
        }
        void this.persistSelection();
        this.options.requestRender();
      };
      const check = card.createSpan({ cls: 'wesight-multi-checkbox' });
      setIcon(check, selected ? 'check' : 'circle');
      const copy = card.createDiv();
      copy.createEl('strong', { text: PLATFORM_COPY[platformId].label });
      copy.createSpan({ text: PLATFORM_COPY[platformId].description });
    }

    const warnings = this.preflightWarnings(snapshot);
    if (access.state !== 'multi-platform' && this.selected.size > 1) {
      warnings.unshift(MULTI_PUBLISH_FREE_LIMIT_NOTICE);
    }
    if (warnings.length) {
      const note = parent.createDiv({ cls: 'wesight-multi-preflight' });
      const icon = note.createSpan();
      setIcon(icon, 'triangle-alert');
      const copy = note.createDiv();
      copy.createEl('strong', { text: `启动前提示 · ${warnings.length} 项` });
      for (const warning of warnings.slice(0, 3)) copy.createSpan({ text: warning });
      if (warnings.length > 3) copy.createSpan({ text: `另有 ${warnings.length - 3} 项提示` });
    }

    const start = parent.createEl('button', {
      cls: 'wesight-share-primary-button is-multi',
      text: this.busy ? '正在启动…' : `准备到 ${this.selected.size} 个平台`,
      attr: { type: 'button' },
    });
    const icon = start.createSpan();
    setIcon(icon, 'send');
    start.prepend(icon);
    start.disabled = this.busy || this.selected.size === 0;
    start.onclick = () => void this.start(false);
  }

  private renderTask(parent: HTMLElement, task: MultiPublishTaskState): void {
    const heading = parent.createDiv({ cls: 'wesight-multi-section-heading' });
    heading.createEl('strong', { text: '发布准备进度' });
    const ready = task.targets.filter(platformId => task.platforms[platformId].status === 'ready').length;
    heading.createSpan({ text: `${ready}/${task.targets.length}` });
    const list = parent.createDiv({ cls: 'wesight-multi-task-list' });
    for (const platformId of task.targets) {
      if (!MULTI_PLATFORM_IDS.includes(platformId as MultiPublishSelectablePlatformId)) continue;
      const platform = platformId as MultiPublishSelectablePlatformId;
      const state = task.platforms[platformId];
      const row = list.createDiv({ cls: `wesight-multi-task-row is-${state.status}` });
      const icon = row.createSpan({ cls: 'wesight-multi-task-icon' });
      setIcon(icon, state.status === 'ready' ? 'circle-check' : state.status === 'failed' || state.status === 'login_required' ? 'circle-alert' : 'loader-circle');
      const copy = row.createDiv({ cls: 'wesight-multi-task-copy' });
      copy.createEl('strong', { text: PLATFORM_COPY[platform].label });
      copy.createSpan({ text: state.message || STATUS_COPY[state.status] });
      const actions = row.createDiv({ cls: 'wesight-multi-task-actions' });
      if (state.status === 'ready' || state.status === 'login_required') {
        const open = actions.createEl('button', { text: '打开', attr: { type: 'button' } });
        open.onclick = () => void this.open(platformId);
      }
      if (state.status === 'failed' || state.status === 'login_required') {
        const retry = actions.createEl('button', { text: '重试', attr: { type: 'button' } });
        retry.onclick = () => void this.retry(platformId);
      }
    }
    const restart = parent.createEl('button', {
      cls: 'wesight-share-secondary-button wesight-multi-new-task',
      text: '重新选择平台',
      attr: { type: 'button' },
    });
    restart.onclick = () => {
      this.task = null;
      void this.load();
    };
  }

  private renderError(parent: HTMLElement): void {
    const note = parent.createDiv({ cls: 'wesight-share-error' });
    const icon = note.createSpan();
    setIcon(icon, 'circle-alert');
    note.createSpan({ text: this.error || '操作失败，请稍后重试。' });
  }

  private preflightWarnings(snapshot: MultiPublishSnapshot): string[] {
    const warnings = [...snapshot.warnings];
    const titleLength = Array.from(snapshot.title).length;
    for (const platformId of this.selected) {
      const platform = PLATFORM_COPY[platformId];
      if (titleLength > platform.titleLimit) {
        warnings.push(`${platform.label}标题最多 ${platform.titleLimit} 个字符，扩展会截断填充`);
      }
    }
    return Array.from(new Set(warnings));
  }

  private async persistSelection(): Promise<void> {
    this.options.getSettings().multiPublishPlatforms = MULTI_PLATFORM_IDS.filter(platformId => this.selected.has(platformId));
    await this.options.saveSettings();
  }

  private async start(forcePair: boolean): Promise<void> {
    if (!this.snapshot || this.busy || this.selected.size === 0) return;
    this.busy = true;
    this.error = '';
    this.options.requestRender();
    try {
      const user = await this.options.auth.restoreSession();
      if (!user) {
        new Notice(MULTI_PUBLISH_LOGIN_PROMPT);
        return;
      }
      let billing = this.options.auth.getBillingSummary();
      if (this.selected.size > 1) {
        try {
          billing = await this.options.auth.refreshBillingSummary(false);
        } catch {
          this.error = '暂时无法验证会员状态，请稍后重试。';
          return;
        }
      }
      const access = resolveMultiPublishAccess(user, billing);
      const accessError = validateMultiPublishTargetCount(access, this.selected.size);
      if (accessError) {
        new Notice(accessError);
        return;
      }
      if (forcePair) await this.options.bridge.clearPairing();
      await this.persistSelection();
      const result = this.options.bridge.createTask(this.snapshot, Array.from(this.selected), forcePair);
      this.task = result.task;
      window.open(result.handoffUrl, '_blank', 'noopener,noreferrer');
      new Notice('已打开浏览器交接页，扩展正在准备多平台草稿。');
    } catch (error) {
      this.error = error instanceof Error ? error.message : '多平台任务启动失败';
    } finally {
      this.busy = false;
      this.options.requestRender();
      this.options.requestPosition();
    }
  }

  private async retry(platformId: MultiPlatformId): Promise<void> {
    if (!this.task) return;
    try {
      const url = this.options.bridge.createRetryUrl(this.task.taskId, platformId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      this.error = error instanceof Error ? error.message : '重试失败';
      this.options.requestRender();
    }
  }

  private async open(platformId: MultiPlatformId): Promise<void> {
    if (!this.task) return;
    try {
      const url = this.options.bridge.createOpenUrl(this.task.taskId, platformId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      this.error = error instanceof Error ? error.message : '打开平台草稿失败';
      this.options.requestRender();
    }
  }
}
