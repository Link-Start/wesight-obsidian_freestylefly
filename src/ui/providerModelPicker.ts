import { setIcon } from 'obsidian';
import type { ProviderProfile } from '../types';
import { isTokenDanceProfile } from '../tokendance/service';
import { isOpenLuxProfile } from '../openlux/service';
import { profileCatalog } from '../openlux/catalog';
import { renderModelCatalog } from './modelCatalog';
import { renderModelIcon } from './modelIcons';

export function showProviderModelPicker(trigger: HTMLElement, options: {
  profiles: ProviderProfile[];
  selectedProfileId: string;
  onSelect: (profileId: string, model: string) => void;
  onManage: () => void;
  onClose: () => void;
}): () => void {
  const rank = (profile: ProviderProfile): number => isTokenDanceProfile(profile) ? 0 : isOpenLuxProfile(profile) ? 1 : 2;
  const profiles = [...options.profiles].sort((a, b) => rank(a) - rank(b));
  let active = profiles.find(profile => profile.id === options.selectedProfileId) ?? profiles[0];
  const popup = createDiv();
  popup.className = 'wesight-provider-picker';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', '选择供应商和模型');
  trigger.setAttr('aria-expanded', 'true');
  const sidebar = popup.createDiv({ cls: 'wesight-picker-sidebar' });
  sidebar.createDiv({ cls: 'wesight-model-group', text: '模型供应商' });
  const suppliers = sidebar.createDiv({ cls: 'wesight-picker-suppliers' });
  const manage = sidebar.createEl('button', { cls: 'wesight-picker-manage', text: '管理供应商 ↗', attr: { type: 'button' } });
  const detail = popup.createDiv({ cls: 'wesight-picker-detail' });
  let catalog: ReturnType<typeof renderModelCatalog> | undefined;
  const render = (): void => {
    suppliers.empty();
    detail.empty();
    for (const profile of profiles) {
      const selected = profile.id === active?.id;
      const row = suppliers.createEl('button', { cls: 'wesight-picker-supplier', attr: { type: 'button', 'aria-pressed': String(selected) } });
      row.toggleClass('is-selected', selected);
      renderModelIcon(row.createSpan(), isOpenLuxProfile(profile) ? 'openlux' : isTokenDanceProfile(profile) ? 'tokendance' : profile.providerKey || profile.name.toLowerCase());
      row.createSpan({ cls: 'wesight-picker-supplier-name', text: profile.name });
      if (profile.id === options.selectedProfileId) setIcon(row.createSpan({ cls: 'wesight-catalog-check' }), 'check');
      row.onclick = () => {
        active = profile;
        render();
        suppliers.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
      };
    }
    if (!active) {
      detail.createDiv({ cls: 'wesight-provider-empty', text: '请先添加 Claude Code 模型配置。' });
      return;
    }
    const profile = active;
    const models = profileCatalog(profile);
    const header = detail.createDiv({ cls: 'wesight-picker-title' });
    header.createSpan({ text: profile.name });
    header.createSpan({ cls: 'wesight-catalog-count', text: `${models.length} 个模型` });
    catalog = renderModelCatalog(detail, {
      getModels: () => models,
      getSelected: () => profile.id === options.selectedProfileId ? profile.defaultModel || profile.model : '',
      groupByVendor: isOpenLuxProfile(profile),
      onSelect: id => { options.onSelect(profile.id, id); dispose(); },
    });
  };
  render();
  document.body.appendChild(popup);
  const position = (): void => {
    const anchor = trigger.getBoundingClientRect();
    const width = Math.min(560, Math.max(0, window.innerWidth - 24));
    const above = anchor.top - 18;
    const below = window.innerHeight - anchor.bottom - 18;
    const up = above >= 260 || above > below;
    const height = Math.max(0, Math.min(420, up ? above : below));
    const dynamicStyles = {
      width: `${width}px`, 'max-height': `${height}px`,
      left: `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`,
      top: up ? `${Math.max(12, anchor.top - popup.getBoundingClientRect().height - 6)}px` : `${anchor.bottom + 6}px`,
    };
    popup.setCssProps(dynamicStyles);
  };
  position();
  // Reposition after applying the constrained height.
  position();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    popup.remove();
    document.removeEventListener('mousedown', outside);
    window.removeEventListener('resize', position);
    document.removeEventListener('scroll', scroll, true);
    trigger.setAttr('aria-expanded', 'false');
    options.onClose();
  };
  const outside = (event: MouseEvent): void => {
    if (event.target instanceof Node && !popup.contains(event.target) && !trigger.contains(event.target)) dispose();
  };
  const scroll = (event: Event): void => { if (!(event.target instanceof Node) || !popup.contains(event.target)) position(); };
  popup.onkeydown = event => {
    if (event.key === 'Tab') {
      const controls = Array.from(popup.querySelectorAll<HTMLElement>('button, input')).filter(element => !element.closest('[hidden]'));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if (event.key === 'Escape') { event.stopPropagation(); dispose(); trigger.focus(); }
    if (event.key === 'ArrowRight' && event.target instanceof Node && sidebar.contains(event.target)) { event.preventDefault(); catalog?.focus(); }
    if (event.key === 'ArrowLeft' && event.target instanceof Node && detail.contains(event.target) && !(event.target.instanceOf(HTMLInputElement))) {
      event.preventDefault(); suppliers.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && event.target instanceof Node && suppliers.contains(event.target)) {
      const buttons = Array.from(suppliers.querySelectorAll<HTMLButtonElement>('button'));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[Math.max(0, Math.min(buttons.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      event.preventDefault();
    }
  };
  manage.onclick = () => { dispose(); options.onManage(); };
  document.addEventListener('mousedown', outside);
  window.addEventListener('resize', position);
  document.addEventListener('scroll', scroll, true);
  catalog?.focus();
  return dispose;
}
