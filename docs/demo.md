# 演示步骤

先按 README 启动 server 和 web，并用两个浏览器配置文件打开 `http://127.0.0.1:5173`。两个页面分别注册真实账户；如果要进入默认演示空间，可以在注册页用 `alice` handle 认领旧种子账户。

1. 在 owner 账户的项目成员面板输入另一个账户的 handle 或 email，发送邀请；第二个账户在“待处理邀请”中接受后才加入项目。
2. owner 账号可以编辑正文，viewer 账号只读；编辑更新会通过 Yjs 同步到其他已登录窗口。
3. 选中一句话，点击「评论选区」，发布包含 `@Polisher` 的消息，例如 `@Polisher 把「术语」改成「新术语」`。评论正文的提及由 server 解析，Agent 标签会短暂显示「处理中」。
4. 打开「建议」标签。默认 mock agent 会留下 reply，并按允许上下文生成待审建议；有 `editor` / `owner` 权限的真实账户选择「接受」后，正文在 Yjs 文档中替换，其他窗口通过 SSE/WS 更新。
5. 直接修改建议锚定的原文后再审批，建议会进入 stale。对 agent 生成的 stale 建议可以点击「重新生成」。
6. 在成员面板打开 Agent 配置，查看适配器、上下文策略和 working/idle/failed 状态；owner 可以选择本机 Codex/Claude CLI 或 OpenAI-compatible API，并设置公开/私有交互权限。API key 只在当前 server 进程内使用；`GET /api/docs/demo-doc/agent-runs` 可查看运行记录。
7. 新建评论时勾选「作为任务」并选择 Polisher；任务线程创建后会立即触发一次 agent 运行，后续建议可按 Batch 进度接受剩余或拒绝剩余。

默认 agent 使用 mock 适配器。OpenAI-compatible 与 CLI 适配器遵循同一纯文本接口，切换配置后仍由相同的输出协议、权限和锚点校验处理；也可以通过 `COLLAB_AGENT_CONFIG_JSON` 预配置环境变量型 API 连接，不需要改流程代码。
