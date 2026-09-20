import { Notice } from 'obsidian';
import type { MemberAiService } from '../memberAi/service';
import type { ClaudeInstaller } from '../memberAi/installer';
import { MEMBER_AI_MESSAGES } from '../memberAi/types';
import type { CloudAuthService } from '../share/cloudAuth';
import { RuntimeDiscovery } from '../runtime/discovery';
import type { WeSightObsidianSettings } from '../types';

export function renderMemberAiCard(
  parent: HTMLElement,
  deps: {
    service: MemberAiService;
    installer: ClaudeInstaller;
    auth: CloudAuthService;
    getSettings: () => WeSightObsidianSettings;
    switchCustom: () => Promise<void>;
    selectedModel?: () => string;
    selectModel?: (id: string) => Promise<void>;
  },
): () => void {
  const card = parent.createDiv({ cls: 'wesight-member-ai-card' });
  const action = (label: string, run: () => void | Promise<void>) => {
    const b = card.createEl('button', { text: label });
    b.onclick = () => {
      void Promise.resolve(run()).catch(() => new Notice('操作未完成，请重试。'));
    };
    return b;
  };
  const render = (): void => {
    card.empty();
    const status = deps.service.status;
    card.createEl('h4', { text: '使用准备' });
    const found = new RuntimeDiscovery({ configuredPaths: deps.getSettings().configuredPaths }).resolve('claude').found;
    if (!found) {
      card.createEl('p', {
        text: deps.installer.message || '首次使用需要安装 Claude Code。点击后从官方下载安装，无需配置 API Key。',
      });
      if (deps.installer.busy) action('取消安装', () => deps.installer.cancel());
      else action(deps.installer.state === 'error' ? '重试安装' : '一键安装', () => deps.installer.install());
      action('官方安装指南', () => {
        window.open('https://code.claude.com/docs/en/setup', '_blank', 'noopener,noreferrer');
      });
    }
    card.createEl('p', {
      text:
        !found && status.state === 'ready'
          ? '会员权益已就绪，安装 Claude Code 后即可聊天。'
          : MEMBER_AI_MESSAGES[status.state],
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    if (status.state === 'login-required') action('登录 WeSight', () => deps.auth.startLogin());
    if (status.state === 'membership-required' || status.state === 'expired')
      action(status.state === 'expired' ? '续费会员' : '开通会员', () => deps.auth.openBilling());
    if (status.membership.active) {
      const percent = Math.max(0, Math.min(100, status.quota.remainingPercent));
      card.createEl('p', { text: `本周剩余 ${percent}% · 会员有效` });
      card.createEl('progress', { attr: { max: '100', value: String(percent), 'aria-label': '会员 AI 本周剩余额度' } });
      card.createEl('p', {
        text: status.quota.resetsAt
          ? `恢复时间：${new Date(status.quota.resetsAt).toLocaleString()}`
          : '首次调用后开启 7 天额度周期。',
      });
    }
    if (status.models.length && deps.selectModel) {
      const label = card.createEl('label', { text: '会员模型 ' });
      const select = label.createEl('select', { cls: 'dropdown', attr: { 'aria-label': 'WeSight 会员模型' } });
      for (const model of status.models) select.createEl('option', { value: model.id, text: model.name });
      const current = deps.selectedModel?.() || status.defaultModel;
      if (current && !status.models.some((m) => m.id === current))
        select.createEl('option', { value: current, text: `${current}（当前不可用）` });
      select.value = current;
      select.onchange = () => {
        void deps.selectModel!(select.value).catch(() => new Notice('模型选择未保存，请重试。'));
      };
    }
    const refresh = action('刷新状态', () => deps.service.refresh().then(() => {}));
    refresh.disabled = status.state === 'checking';
    action('切换自定义配置', deps.switchCustom);
  };
  const unsub = deps.service.onChange(render);
  const unInstall = deps.installer.onChange(render);
  const focus = () => {
    void deps.service.refresh();
  };
  parent.ownerDocument.defaultView?.addEventListener('focus', focus);
  render();
  void deps.service.refresh();
  return () => {
    unsub();
    unInstall();
    parent.ownerDocument.defaultView?.removeEventListener('focus', focus);
  };
}
