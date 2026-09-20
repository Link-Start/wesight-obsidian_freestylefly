# 默认配置（推荐）：WeSight 会员模型

新安装默认 Claude Code → 默认配置（推荐）。已有设置保持原引擎和配置来源；缺少配置来源的旧设置按历史本地模式迁移，不覆盖供应商、自备 API 或 TokenDance 个人授权。

设置页 Claude 模型配置置顶，三种来源：默认配置（推荐）、自定义配置、本地配置。推荐模式不显示 API 地址或 Key 表单；设置页和聊天区复用使用准备卡，展示安装、登录、会员状态、模型、周剩余百分比与本地时区准确恢复时间。返回插件时自动刷新权益，刷新卡片不清空输入。

首次发送确认消息/上下文/工具结果会发送给 WeSight 及模型服务商。用户取消、未安装、未登录、未开通、会员到期或额度不足均不清空草稿。网络异常不回退到个人凭据。原有工具权限规则保持不变。

## 实现路径

- src/memberAi/settings.ts：新旧配置迁移。
- src/memberAi/service.ts：云端状态、告知确认、临时本机凭据、回环 HTTP 网关、认证刷新及取消。
- src/memberAi/requestIdentity.ts：SDK 重试幂等标识，只缓存短期摘要/ID，不缓存消息。
- src/memberAi/projection.ts：隔离旧供应商环境、代理和凭据；CLI 只拿到临时回环 token。CLI settings 覆盖供应商相关项，保留本地权限规则。
- src/memberAi/installer.ts：复用已有 Claude Code；仅经点击运行官方安装。macOS/Linux 使用 bash，Windows 使用 PowerShell，不提权、不绕过执行策略。只允许 claude.ai 官方脚本及已核验的 downloads.claude.ai bootstrap 跳转，脚本上限 1 MiB；可取消/重试，完成后自动保存可执行路径和版本。
- src/ui/memberAiCard.ts：共用准备卡；src/ui/settingsTab.ts、src/ui/chatView.ts：三来源与会员模型选择。
- src/runtime/runtimeManager.ts、src/runtime/adapter.ts：会员运行入口；src/ui/inlineEdit.ts：行内编辑同入口。主题生成、小红书文本及知识大脑 Claude 调用也尊重会员模式，避免使用残留本地模型覆盖值。
- src/types.ts、src/main.ts：默认值、初始化和配置归一化；styles.css：准备卡样式。

配置字段：configSources.claude=wesightManaged、memberAiModel（空值跟随云端默认）、memberAiConsentUserId（当前告知已确认的用户）。StoredConversation.managedModel 在首次发送前固定模型；管理员修改默认模型不会改写进行中的会话，用户可以主动切换。

插件不保存上游平台 Key。回环仅绑定 127.0.0.1 随机端口，临时凭据在内存中；WeSight 登录令牌由已有登录服务保管，仅发往固定 https://api.wesight.ai 和 https://ai-gateway.wesight.ai。账户变更会中断请求并轮换本机 token。登录凭据、平台 Key 不进入 Claude 子进程环境或供应商导出配置。

## 模型与额度

默认 deepseek-v4.1-flash；可选 glm-5.3-flash、glm-5.3、deepseek-v4-pro-0813、kimi-k3、hy4-preview。前四个由云端走 Anthropic Messages；Kimi/Hy4 由云端转换为 OpenAI Chat Completions。实际开放模型由后台及实时目录共同校验。

所有套餐使用独立 AI 周额度，完全分离现有积分。首次获准请求起每 7 天恢复，续费、切模型、换设备均不重置；不会自动扣积分或自动使用其他 API。显示百分比与恢复时间，额度金额、模型费率仅由管理员配置。

云端完整配置、SQL 迁移、部署及核对说明见相邻 wesight-cloud/ai-gateway/README.md。此开发阶段没有部署，未运行生产迁移，未启用会员模型。

## 测试与人工验收

```bash
npm run check
npx vitest run tests/memberAi.test.ts tests/memberAiInstaller.test.ts
# 可选：指定已经安装的 Claude 可执行文件，只访问模拟本机服务，不产生平台费用
WESIGHT_TEST_CLAUDE_BINARY=/absolute/path/to/claude npx vitest run tests/memberAiClaudeSmoke.test.ts
```

会员测试覆盖新旧迁移、网关域名、凭据隔离、退出登录、确认取消、认证刷新、重试 ID、会员不可用状态、三平台安装参数、官方跳转、网络失败、下载大小、复用已有 CLI、取消重试及安装后路径检测。现有 TokenDance、自定义供应商、运行器测试继续参与完整回归。

人工验证：旧用户更新后来源不变；切换推荐配置后看不到 Key 表单；输入消息后登录/取消确认仍保留内容；设置页与聊天卡展示一致；更换模型不影响其他凭据。新安装用空设置验证默认来源。Windows/Linux 安装用 CI 或对应主机验收；本机自动化通过不代表三平台真实安装都已经执行。

内部网关部署后，使用管理员放行的测试会员实际核验六模型文本/流式与工具往返、多设备共享、过期续费、周边界、关闭开关、取消后对账。配置未完成时显示不可用，不能声称线上会员模型已可用。

2026-09-20 本地验证：完整插件检查通过，会员与既有测试共 462 项；可选真实 Claude 测试单独通过。真实 CLI 覆盖项目供应商配置隔离、临时凭据、插件回环代理及 SDK 查询参数兼容。云端 124 项测试、类型检查、独立网关构建及 Next compile 模式编译通过。六模型上游请求使用模拟响应；专属商用凭据未配置，未执行真实付费验收。测试 Vault 已验证旧配置保留、三来源切换、Key 表单隐藏及刷新草稿保留。
