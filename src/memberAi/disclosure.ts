import { App, Modal, Setting } from 'obsidian';
export function confirmMemberAiDisclosure(app: App): Promise<boolean> {
  return new Promise((resolve) => {
    class Disclosure extends Modal {
      private accepted = false;
      override onOpen(): void {
        this.contentEl.createEl('h2', { text: '使用 WeSight 会员模型' });
        this.contentEl.createEl('p', {
          text: '本次消息、选中的文件上下文和工具结果将发送至 WeSight 及模型服务商 TokenDance。调用消耗会员 AI 周额度，与原有积分分开。本地工具权限沿用当前设置。',
        });
        new Setting(this.contentEl)
          .addButton((b) => b.setButtonText('取消').onClick(() => this.close()))
          .addButton((b) =>
            b
              .setButtonText('同意并继续')
              .setCta()
              .onClick(() => {
                this.accepted = true;
                this.close();
              }),
          );
      }
      override onClose(): void {
        resolve(this.accepted);
      }
    }
    new Disclosure(app).open();
  });
}
