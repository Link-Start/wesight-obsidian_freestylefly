import { Notice, setIcon } from 'obsidian';
import type { ProviderProfile } from '../types';
import { mergeCatalogModels, profileCatalog, type CatalogModel } from '../openlux/catalog';
import { OPEN_LUX } from '../openlux/constants';
import type { OpenLuxService } from '../openlux/service';
import { initializeStoredSecretInput, resolveSecretInput } from './secretInput';
import { renderModelCatalog } from './modelCatalog';
import { renderModelIcon } from './modelIcons';

export function renderOpenLuxSettings(parent: HTMLElement, options: {
  service: OpenLuxService;
  profile: ProviderProfile | null;
  onSave: (config: { apiKey: string; baseUrl: string; models: CatalogModel[]; defaultModel: string }) => Promise<void>;
  onCancel: () => void;
}): () => void {
  const controller = new AbortController();
  parent.addClass('wesight-openlux-settings');
  let models = options.profile ? profileCatalog(options.profile) : [];
  let selected = options.profile?.defaultModel || options.profile?.model || '';
  let busy = false;
  let editing: string | undefined;
  const head = parent.createDiv({ cls: 'wesight-provider-detail-head' });
  const title = head.createDiv({ cls: 'wesight-provider-title-wrap' });
  renderModelIcon(title.createSpan(), OPEN_LUX.key);
  title.createEl('h3', { text: 'OpenLux 提供商设置' });
  head.createSpan({ cls: `wesight-provider-status ${options.profile?.apiKey ? 'is-enabled' : ''}`, text: options.profile?.apiKey ? '已配置' : '未配置' });
  const links = parent.createDiv({ cls: 'wesight-provider-help' });
  for (const [text, href] of [['获取 API key ↗', OPEN_LUX.website], ['接入文档 ↗', OPEN_LUX.docsUrl]]) {
    links.createEl('a', { text, href, attr: { target: '_blank', rel: 'noopener noreferrer' } });
  }
  const keyField = parent.createDiv({ cls: 'wesight-provider-field' });
  const keyLabel = keyField.createEl('label', { text: 'API key' });
  const secret = keyLabel.createDiv({ cls: 'wesight-provider-secret' });
  const key = secret.createEl('input', { attr: { type: 'password', placeholder: '输入 OpenLux API key', 'aria-label': 'OpenLux API key' } });
  initializeStoredSecretInput(key, Boolean(options.profile?.apiKey));
  const showKey = secret.createEl('button', { cls: 'wesight-provider-icon-btn', attr: { type: 'button', 'aria-label': '显示或隐藏 API key' } });
  setIcon(showKey, 'eye');
  showKey.onclick = () => { key.type = key.type === 'password' ? 'text' : 'password'; };
  const baseField = parent.createDiv({ cls: 'wesight-provider-field' });
  const baseLabel = baseField.createEl('label', { text: 'API base URL' });
  const base = baseLabel.createEl('input', { attr: { type: 'text', 'aria-label': 'OpenLux API base URL' } });
  base.value = options.profile?.baseUrl || OPEN_LUX.baseUrl;
  parent.createDiv({ cls: 'wesight-provider-help', text: 'OpenAI 兼容 · Claude Code 可选择多家厂商的对话模型。' });
  const status = parent.createDiv({ cls: 'wesight-provider-help', attr: { role: 'status', 'aria-live': 'polite' } });
  const actions = parent.createDiv({ cls: 'wesight-provider-test-row' });
  const test = actions.createEl('button', { text: '测试连接', attr: { type: 'button' } });
  const defaultField = parent.createDiv({ cls: 'wesight-provider-field' });
  defaultField.createDiv({ cls: 'wesight-provider-field-head', text: '默认模型' });
  const defaultWrap = defaultField.createDiv({ cls: 'wesight-catalog-default' });
  const defaultButton = defaultWrap.createEl('button', { cls: 'wesight-catalog-default-button', attr: { type: 'button', 'aria-label': 'OpenLux 默认模型', 'aria-expanded': 'false' } });
  const defaultText = defaultButton.createSpan();
  setIcon(defaultButton.createSpan({ cls: 'wesight-catalog-chevron' }), 'chevron-down');
  const defaultMenu = defaultWrap.createDiv({ cls: 'wesight-catalog-default-menu' });
  defaultMenu.hidden = true;
  const closeDefault = (): void => { defaultMenu.hidden = true; defaultButton.setAttr('aria-expanded', 'false'); };
  const select = (id: string): void => { selected = id; closeDefault(); refresh(); };
  const defaultCatalog = renderModelCatalog(defaultMenu, { getModels: () => models, getSelected: () => selected, onSelect: id => { select(id); defaultButton.focus(); }, selectedLabel: '默认' });
  defaultButton.onclick = () => {
    defaultMenu.hidden = !defaultMenu.hidden;
    defaultButton.setAttr('aria-expanded', String(!defaultMenu.hidden));
    if (!defaultMenu.hidden) defaultCatalog.focus();
  };
  defaultWrap.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); closeDefault(); defaultButton.focus(); } };
  const outside = (event: MouseEvent): void => { if (event.target instanceof Node && !defaultWrap.contains(event.target)) closeDefault(); };
  document.addEventListener('mousedown', outside);
  const modelHead = parent.createDiv({ cls: 'wesight-provider-model-head' });
  const count = modelHead.createSpan();
  const modelActions = modelHead.createDiv({ cls: 'wesight-provider-model-actions' });
  const fetchModels = modelActions.createEl('button', { text: '获取模型列表', attr: { type: 'button' } });
  const add = modelActions.createEl('button', { text: '添加模型', attr: { type: 'button' } });
  parent.createDiv({ cls: 'wesight-provider-help', text: '模型按原厂分类，实际可用性以账户权限为准。' });
  const addPanel = parent.createDiv({ cls: 'wesight-provider-model-add' });
  addPanel.hidden = true;
  const idInput = addPanel.createEl('input', { attr: { placeholder: '模型 ID', 'aria-label': '模型 ID' } });
  const nameInput = addPanel.createEl('input', { attr: { placeholder: '显示名称，可选', 'aria-label': '模型显示名称' } });
  const confirm = addPanel.createEl('button', { text: '添加', attr: { type: 'button' } });
  const cancelEdit = addPanel.createEl('button', { text: '取消', attr: { type: 'button' } });
  const hideEditor = (): void => { addPanel.hidden = true; editing = undefined; };
  const showEditor = (model?: CatalogModel): void => {
    if (busy) return;
    editing = model?.id;
    idInput.value = model?.id ?? '';
    nameInput.value = model?.name ?? '';
    confirm.setText(model ? '保存模型' : '添加');
    addPanel.hidden = false;
    idInput.focus();
  };
  add.onclick = () => showEditor();
  cancelEdit.onclick = hideEditor;
  confirm.onclick = () => {
    if (busy) return;
    const id = idInput.value.trim();
    if (!id) { new Notice('请输入模型 ID。'); idInput.focus(); return; }
    if (models.some(model => model.id === id && model.id !== editing)) { new Notice('模型 ID 已存在。'); return; }
    const previous = models.find(model => model.id === editing);
    const model: CatalogModel = { ...previous, id, name: nameInput.value.trim() || id };
    if (previous?.id !== id) { delete model.modelVendor; delete model.supportsImage; }
    models = editing ? models.map(item => item.id === editing ? model : item) : [...models, model];
    select(!selected || selected === editing ? id : selected);
    hideEditor();
  };
  addPanel.onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); confirm.click(); }
    if (event.key === 'Escape') { event.stopPropagation(); hideEditor(); add.focus(); }
  };
  const catalog = renderModelCatalog(parent, {
    getModels: () => models, getSelected: () => selected, selectedLabel: '默认', onSelect: id => { if (!busy) select(id); },
    onEdit: showEditor,
    onRemove: id => {
      if (busy) return;
      models = models.filter(model => model.id !== id);
      if (selected === id) selected = models[0]?.id ?? '';
      if (editing === id) hideEditor();
      refresh();
    },
  });
  const footer = parent.createDiv({ cls: 'wesight-provider-footer' });
  const cancel = footer.createEl('button', { text: '取消', attr: { type: 'button' } });
  cancel.onclick = options.onCancel;
  const save = footer.createEl('button', { cls: 'mod-cta', text: '保存', attr: { type: 'button' } });
  function refresh(): void {
    count.setText(`可用模型列表 · ${models.length}`);
    defaultText.setText(models.find(model => model.id === selected)?.name || '请选择模型');
    defaultButton.disabled = busy || !models.length;
    catalog.refresh();
    defaultCatalog.refresh();
    for (const button of [fetchModels, add, test, save, confirm, cancelEdit]) button.disabled = busy;
    for (const input of [key, base, idInput, nameInput]) input.disabled = busy;
  }
  async function run(work: () => Promise<void>, success: string): Promise<void> {
    if (busy) return;
    busy = true;
    status.setText('处理中…');
    refresh();
    try {
      await work();
      if (!controller.signal.aborted) { status.setText(success); new Notice(success); }
    } catch (error) {
      if (!controller.signal.aborted) { const message = error instanceof Error ? error.message : 'OpenLux 操作失败。'; status.setText(message); new Notice(message); }
    } finally { busy = false; if (!controller.signal.aborted) refresh(); }
  }
  const config = (): { apiKey: string; baseUrl: string } => ({ apiKey: resolveSecretInput(key.value, options.profile?.apiKey ?? '').trim(), baseUrl: base.value.trim() || OPEN_LUX.baseUrl });
  fetchModels.onclick = () => void run(async () => {
    const fetched = await options.service.fetchCatalog(config(), controller.signal);
    if (controller.signal.aborted) return;
    models = mergeCatalogModels(fetched, models);
    if (!models.some(model => model.id === selected)) selected = models[0]?.id ?? '';
  }, '已更新 OpenLux 模型列表，请选择默认模型并保存。');
  test.onclick = () => void run(async () => {
    await options.service.test({ ...options.profile, ...config(), providerKey: OPEN_LUX.key, agentId: 'claude', name: OPEN_LUX.name,
      id: options.profile?.id ?? 'openlux-test', model: selected, defaultModel: selected, models: models.map(model => model.id),
      wireApi: 'chat', isDefault: true, createdAt: 0, updatedAt: 0 }, controller.signal);
  }, 'OpenLux 连接成功。');
  save.onclick = () => void run(async () => {
    if (!config().apiKey) throw new Error('请先输入 OpenLux API key。');
    if (!selected || !models.some(model => model.id === selected)) throw new Error('请先选择 OpenLux 默认模型。');
    let url: URL;
    try { url = new URL(config().baseUrl); } catch { throw new Error('OpenLux API base URL 无效。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('OpenLux API base URL 无效。');
    await options.onSave({ ...config(), models, defaultModel: selected });
  }, 'OpenLux 已保存为 Claude Code 默认供应商。');
  refresh();
  return () => { controller.abort(); document.removeEventListener('mousedown', outside); };
}
