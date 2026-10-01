import { setIcon } from 'obsidian';
import { groupModelsByVendor, type CatalogModel } from '../openlux/catalog';
import { MODEL_VENDOR_LABELS } from '../providers/modelVendors';
import { renderModelIcon } from './modelIcons';

export function renderModelCatalog(parent: HTMLElement, options: {
  getModels: () => readonly CatalogModel[];
  getSelected: () => string;
  onSelect: (id: string) => void;
  groupByVendor?: boolean;
  onEdit?: (model: CatalogModel) => void;
  onRemove?: (id: string) => void;
  selectedLabel?: string;
}): { refresh: () => void; focus: () => void } {
  const root = parent.createDiv({ cls: 'wesight-model-catalog' });
  const searchWrap = root.createDiv({ cls: 'wesight-catalog-search' });
  setIcon(searchWrap.createSpan(), 'search');
  const search = searchWrap.createEl('input', { attr: { type: 'search', placeholder: '搜索模型名称或 ID', 'aria-label': '搜索模型名称或 ID' } });
  const list = root.createDiv({ cls: 'wesight-catalog-list' });
  const collapsed = new Set<string>();
  const renderRow = (target: HTMLElement, model: CatalogModel): void => {
    const row = target.createDiv({ cls: 'wesight-catalog-row' });
    const selected = options.getSelected() === model.id;
    row.toggleClass('is-selected', selected);
    const button = row.createEl('button', { cls: 'wesight-catalog-select', attr: {
      type: 'button', 'aria-pressed': String(selected), 'aria-label': `选择 ${model.name}`, title: model.id,
    } });
    const copy = button.createSpan({ cls: 'wesight-catalog-copy' });
    copy.createSpan({ cls: 'wesight-catalog-name', text: model.name });
    copy.createSpan({ cls: 'wesight-catalog-id', text: model.id });
    if (model.supportsImage === true) button.createSpan({ cls: 'wesight-catalog-badge', text: '图片输入' });
    if (selected) {
      button.createSpan({ cls: 'wesight-catalog-badge', text: options.selectedLabel ?? '当前' });
      setIcon(button.createSpan({ cls: 'wesight-catalog-check' }), 'check');
    }
    button.onclick = () => options.onSelect(model.id);
    if (options.onEdit || options.onRemove) {
      const actions = row.createDiv({ cls: 'wesight-catalog-actions' });
      if (options.onEdit) {
        const edit = actions.createEl('button', { cls: 'wesight-provider-icon-btn', attr: { type: 'button', 'aria-label': `编辑 ${model.name}` } });
        setIcon(edit, 'pencil');
        edit.onclick = () => options.onEdit?.(model);
      }
      if (options.onRemove) {
        const remove = actions.createEl('button', { cls: 'wesight-provider-icon-btn', attr: { type: 'button', 'aria-label': `删除 ${model.name}` } });
        setIcon(remove, 'trash-2');
        remove.onclick = () => options.onRemove?.(model.id);
      }
    }
  };
  const refresh = (): void => {
    list.empty();
    const models = options.getModels();
    const query = search.value.trim();
    const groups = groupModelsByVendor(models, query);
    if (!groups.length) {
      list.createDiv({ cls: 'wesight-provider-empty', text: models.length ? '未找到匹配模型' : '暂无模型，请获取模型列表或手动添加。', attr: { role: 'status' } });
      return;
    }
    if (options.groupByVendor === false) {
      for (const model of models.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()))) renderRow(list, model);
      return;
    }
    for (const group of groups) {
      const expanded = Boolean(query) || !collapsed.has(group.vendor);
      const section = list.createDiv({ cls: 'wesight-catalog-group' });
      const header = section.createEl('button', { cls: 'wesight-catalog-group-head', attr: { type: 'button', 'aria-expanded': String(expanded) } });
      setIcon(header.createSpan({ cls: 'wesight-catalog-chevron' }), expanded ? 'chevron-down' : 'chevron-right');
      renderModelIcon(header.createSpan(), group.vendor);
      header.createSpan({ cls: 'wesight-catalog-vendor', text: MODEL_VENDOR_LABELS[group.vendor] });
      header.createSpan({ cls: 'wesight-catalog-count', text: String(group.models.length) });
      header.onclick = () => {
        if (collapsed.has(group.vendor)) collapsed.delete(group.vendor); else collapsed.add(group.vendor);
        refresh();
        list.querySelector<HTMLButtonElement>(`[data-vendor="${group.vendor}"]`)?.focus();
      };
      header.dataset.vendor = group.vendor;
      if (expanded) for (const model of group.models) renderRow(section, model);
    }
  };
  search.oninput = refresh;
  root.onkeydown = event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target === search && event.key !== 'ArrowDown') return;
    const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('button'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    if (buttons[next]) { event.preventDefault(); buttons[next].focus(); }
  };
  refresh();
  return { refresh, focus: () => search.focus() };
}
