import { Notice } from 'obsidian';
import type { ProviderProfile } from '../types';
import { TOKEN_DANCE, TOKEN_DANCE_MODEL_IDS } from '../tokendance/catalog';
import type { TokenDanceService } from '../tokendance/service';

export function renderTokenDanceSettings(parent: HTMLElement, options: {
  service: TokenDanceService;
  profile: ProviderProfile | null;
  onSave: (model: string) => Promise<void>;
}): void {
  const { service } = options;
  parent.addClass('wesight-tokendance-settings');
  let selected = options.profile?.defaultModel || TOKEN_DANCE_MODEL_IDS[0];
  let busy = false;
  let status = '';
  const render = (): void => {
    parent.empty();
    const head = parent.createDiv({ cls: 'wesight-provider-detail-head' });
    head.createEl('h3', { text: 'TokenDance · 词元跳动' });
    head.createSpan({ cls: `wesight-provider-status ${service.connected ? 'is-enabled' : ''}`,
      text: service.connected ? '已连接' : '未连接' });
    parent.createEl('p', { cls: 'wesight-provider-help', text: '在浏览器授权后即可使用。密钥由 Obsidian 安全存储保存。' });
    const actions = parent.createDiv({ cls: 'wesight-provider-test-row' });
    const connect = actions.createEl('button', { text: service.authorizing ? '等待浏览器授权…' : service.connected ? '重新授权' : '连接 TokenDance' });
    connect.disabled = busy || service.authorizing;
    connect.onclick = () => {
      const flow = service.authorize();
      void run(async () => {
        await flow;
        await service.refreshCatalog();
        if (!service.models.some(model => model.id === selected)) selected = service.models[0]?.id ?? selected;
      }, 'TokenDance 已连接，请选择默认模型并保存。');
    };
    if (service.authorizing) {
      const cancel = actions.createEl('button', { text: '取消授权' });
      cancel.onclick = () => service.cancel();
    } else if (service.connected) {
      const disconnect = actions.createEl('button', { text: '断开连接' });
      disconnect.disabled = busy;
      disconnect.onclick = () => {
        service.disconnect();
        render();
        new Notice('已清除本机 TokenDance 授权。可前往官网管理或撤销旧密钥。');
      };
    }
    const field = parent.createDiv({ cls: 'wesight-provider-field' });
    const label = field.createEl('label', { text: '默认模型' });
    const select = label.createEl('select', { cls: 'dropdown', attr: { 'aria-label': 'TokenDance 默认模型' } });
    const models = service.models;
    if (!models.some(model => model.id === selected)) select.createEl('option', { text: `${selected} · 当前不可用`, value: selected });
    for (const model of models) select.createEl('option', { value: model.id, text: model.name });
    select.value = selected;
    select.disabled = busy;
    select.onchange = () => { selected = select.value; render(); };
    const description = parent.createDiv({ cls: 'wesight-provider-help' });
    const current = models.find(model => model.id === selected);
    description.setText(current?.supportedProtocols.includes(TOKEN_DANCE.messages)
      ? 'Claude Code 原生协议 · Anthropic Messages'
      : 'Claude Code 兼容模式 · OpenAI Chat Completions（支持文本、图片和工具调用）');
    if (!service.catalogVerified) parent.createEl('p', { cls: 'wesight-provider-help', text: '当前展示内置目录；保存和运行前会校验实时模型与协议。' });
    const list = parent.createDiv({ cls: 'wesight-provider-model-list' });
    for (const model of models) {
      const card = list.createDiv({ cls: 'wesight-provider-model-card', attr: { role: 'button', tabindex: '0', 'aria-label': `选择 ${model.name}` } });
      card.toggleClass('is-selected', model.id === selected);
      card.setAttr('aria-pressed', String(model.id === selected));
      card.onclick = () => { if (!busy) { selected = model.id; render(); } };
      card.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); } };
      card.createSpan({ cls: 'wesight-provider-model-dot' });
      const copy = card.createDiv();
      copy.createDiv({ cls: 'wesight-provider-model-name', text: model.name });
      copy.createDiv({ cls: 'wesight-provider-model-id', text: model.id });
      copy.createDiv({ cls: 'wesight-provider-help', text: model.supportedProtocols.includes(TOKEN_DANCE.messages) ? '原生 Messages' : 'OpenAI 兼容模式' });
    }
    const missing = TOKEN_DANCE_MODEL_IDS.filter(id => !models.some(model => model.id === id));
    if (missing.length) parent.createEl('p', { text: `实时目录暂不可用：${missing.join('、')}` });
    const buttons = parent.createDiv({ cls: 'wesight-provider-test-row' });
    const refresh = buttons.createEl('button', { text: '刷新模型目录' });
    refresh.disabled = busy;
    refresh.onclick = () => void run(async () => { await service.refreshCatalog(); }, '已更新 TokenDance 实时模型目录。');
    const test = buttons.createEl('button', { text: '测试连接' });
    test.disabled = busy || !service.connected || !current;
    test.onclick = () => void run(() => service.test(testProfile(selected)), `连接成功：${selected}`);
    const save = buttons.createEl('button', { cls: 'mod-cta', text: '保存并用于 Claude Code' });
    save.disabled = busy || !service.connected || !current;
    save.onclick = () => void run(async () => {
      await service.refreshCatalog();
      if (!service.models.some(model => model.id === selected)) throw new Error('所选模型当前不可用，请重新选择。');
      await options.onSave(selected);
    }, 'TokenDance 已保存为 Claude Code 默认供应商。');
    if (status) parent.createEl('p', { cls: 'wesight-provider-help', text: status, attr: { role: 'status', 'aria-live': 'polite' } });
    const details = parent.createEl('details');
    details.createEl('summary', { text: '连接信息' });
    details.createEl('p', { text: `API Base URL：${TOKEN_DANCE.baseUrl}` });
    details.createEl('p', { text: '原生接口：/v1/messages；兼容模式：/v1/chat/completions。' });
    const link = details.createEl('a', { text: '管理 TokenDance 密钥', href: `${TOKEN_DANCE.origin}/keys` });
    link.setAttr('target', '_blank'); link.setAttr('rel', 'noopener noreferrer');
  };
  const run = async (action: () => Promise<void>, success: string): Promise<void> => {
    busy = true; status = '正在处理…'; render();
    try { await action(); status = success; new Notice(status); }
    catch (error) { status = error instanceof Error ? error.message : 'TokenDance 操作失败，请重试。'; new Notice(status); }
    finally { busy = false; if (parent.isConnected) render(); }
  };
  render();
}

function testProfile(model: string): ProviderProfile {
  return { id: 'tokendance-test', agentId: 'claude', name: TOKEN_DANCE.name,
    apiKey: TOKEN_DANCE.credentialRef, baseUrl: TOKEN_DANCE.baseUrl, model,
    defaultModel: model, models: [model], wireApi: 'chat', anthropicAuthMode: 'authToken',
    isDefault: false, createdAt: 0, updatedAt: 0 };
}
