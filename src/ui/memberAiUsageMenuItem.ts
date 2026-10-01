import type { Menu } from 'obsidian';
import type { MemberAiService } from '../memberAi/service';
import type { CloudAuthService } from '../share/cloudAuth';

export function addMemberAiUsageMenuItem(
  menu: Menu,
  service: MemberAiService,
  auth: CloudAuthService,
): () => void {
  const title = createFragment();
  const row = createDiv({ cls: 'wesight-account-menu-usage' });
  row.createSpan({ text: '使用情况' });
  const remaining = row.createSpan({ cls: 'wesight-account-menu-quota' });
  title.append(row);

  const update = () => {
    const { state, membership, quota } = service.status;
    const hasQuota = membership.active
      && (state === 'ready' || state === 'quota-exhausted')
      && Number.isFinite(quota.remainingPercent);
    remaining.textContent = hasQuota
      ? `剩余 ${Math.round(Math.max(0, Math.min(100, quota.remainingPercent)))}%`
      : state === 'checking' ? '加载中…' : '剩余 —';
  };
  update();
  menu.addItem(item => item
    .setTitle(title)
    .setIcon('gauge')
    .onClick(() => auth.openUsage()));
  const unsubscribe = service.onChange(update);
  void service.refresh();
  return unsubscribe;
}
