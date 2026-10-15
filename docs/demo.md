# 演示步骤

先按 README 启动 server 和 web，并用两个浏览器页打开 `http://127.0.0.1:5173`。

1. 在一个页选择 Bob，在另一个页选择 Dan。Bob 可以编辑正文，Dan 的编辑器只读；Bob 的更新会同步到 Dan。
2. Bob 选中一句话，点击「评论选区」，发布包含 `@Polisher` 的消息，例如 `@Polisher 把「术语」改成「新术语」`。评论正文的提及由 server 解析，Agent 标签会短暂显示「处理中」。
3. 打开「建议」标签。默认 mock agent 会留下 reply，并按允许上下文生成待审建议；Alice 或 Bob 选择「接受」后，正文在 Yjs 文档中替换，其他窗口通过 SSE/WS 更新。
4. 用 Dan 发送同样格式的提及。Dan 的有效角色是 commenter，agent 只回复并说明修改被丢弃，不会创建建议。
5. 直接修改建议锚定的原文后再审批，建议会进入 stale。对 agent 生成的 stale 建议可以点击「重新生成」。
6. 选择「Agent」标签查看适配器、上下文策略和 working/idle/failed 状态；`GET /api/docs/demo-doc/agent-runs` 可查看运行记录。

默认 agent 使用 mock 适配器。OpenAI-compatible 与 CLI 适配器遵循同一纯文本接口，切换配置后仍由相同的输出协议、权限和锚点校验处理；通过 `COLLAB_AGENT_CONFIG_JSON` 传入配置数组即可切换，不需要改流程代码。
