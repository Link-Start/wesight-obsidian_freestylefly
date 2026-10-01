# OpenLux 接入

在 WeSight 设置 → Claude → OpenLux 中填写 API key，默认地址为 `https://api.openlux.ai/v1`。点击“获取模型列表”，选择默认模型后保存。OpenLux 紧接 TokenDance，仅支持 Claude Code。

模型目录来自账户的 `GET /v1/models`，通过 Bearer 鉴权获取。目录按 OpenAI、Google、Anthropic、DeepSeek 等模型厂商分类，支持名称／ID 搜索、折叠分组及手动添加、编辑、删除。未知模型归入“其他”。获取失败保留当前列表；刷新保留自定义名称和手动模型。模型 ID 的供应商前缀原样发送。

自动目录过滤专用图片生成、视频、语音、嵌入和重排模型。图片输入标记只依据接口明确返回的能力数据；模型的实际可用性、工具调用和图片支持以平台与账户权限为准。手动模型允许填写平台提供的精确 ID。

聊天模型选择器采用两栏布局：左侧选择供应商，右侧选择模型。OpenLux 右侧按原厂分组，选中后显示模型名称及“OpenLux · 厂商”。切换沿用现有插件默认配置语义；Codex 本机模式、OpenCode、会员模型及本机 Claude 配置继续使用原有流程。

## 协议与凭据

Claude Code 请求本机 `127.0.0.1` 代理，由代理转换 Anthropic Messages 与 OpenAI Chat Completions。支持系统提示、文本、图片、工具选择、工具结果、思考片段、流式及非流式返回。兼容模式的 token 计数采用本地估算，仅用于 CLI 预算；计费以 OpenLux 为准。

每轮运行使用独立随机本机令牌，绑定该轮供应商地址、密钥及模型配置的快照。Claude 子进程只收到本机地址和临时令牌；真实 API key 保存在 Obsidian SecretStorage，默认导出脱敏。运行结束释放令牌，取消、连接测试结束及插件卸载中止对应请求。代理不会改写用户的 Claude 配置文件。

连接测试通过相同代理发送一条最小消息并校验有效返回。测试及聊天会消耗 OpenLux 账户额度。鉴权、余额不足、限流和网络异常提供明确提示，上游错误正文不直接展示。

供应商记录增加可选 `providerKey` 和 `modelCatalog`，保留旧的模型 ID 列表与默认模型字段；旧配置无需迁移，目录名称、厂商和明确图片能力随配置持久化及导入导出。

## 验证

- 自动测试：`npm test -- tests/openLux.test.ts tests/providerStore.test.ts tests/runtimeManager.test.ts tests/tokenDance.test.ts`。
- 全量检查：`npm run check`。
- 界面检查：供应商排序、默认模型、厂商搜索和折叠、手动编辑、明暗主题、窄侧栏、键盘操作和取消保存。
- 真实服务测试需要在设置中填写自己的 OpenLux API key。模拟传输测试覆盖协议行为，真实模型权限和生成结果需另行联调。

本次验证：`npm run check` 通过，483 项测试通过，1 项可选测试跳过；lint 无错误，构建与发布资源校验通过。TokenDance、会员模型及旧供应商用例均参与回归。

Obsidian 中已检查 Claude 专属入口、供应商排序、手动添加、搜索、折叠、默认选择、取消后目录保持为空，以及明暗主题和约 350px 侧栏下的弹层、外部点击关闭与 Escape 焦点恢复。隔离组件页另以模拟 OpenLux 目录检查两栏厂商分组、完整 ID 选择、默认模型保存恢复、390px 视口及键盘焦点循环。界面验证未保存测试供应商到用户的共享目录，测试结束恢复原 Claude 配置来源；未使用真实 OpenLux Key；真实服务联调需使用自己的账户密钥。

文档：[OpenLux 官方接入说明](https://doc.openlux.ai/en/tutorials/00-intro)。设计与分类逻辑参考相邻 WeSight 客户端的 OpenLux 设置、模型目录组件及两栏模型选择器。
