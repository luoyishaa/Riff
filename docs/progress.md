# 进度

### M0 报告
- 完成情况：✅ 已建立 pnpm workspace、TypeScript strict、Vitest、ESLint、Prettier、边界检查与六个包/应用目录。
- 如何验证：`pnpm check`。
- 偏离与决定：边界检查决定见 `docs/decisions.md`。
- 已知问题：M1 功能尚未完成。
- 下一步建议：实现 kernel、SQLite 文档存储、WebSocket 同步和最小 Web 客户端。

### M1 报告
- 完成情况：✅ `packages/kernel` 提供 Principal / Role / 表驱动 `can()`、Result、Clock / IdGenerator、Yjs `DocumentHandle` 与 Anchor 创建/解析；✅ `apps/server` 提供 SQLite 文档存储、种子配置、文档查询和 WebSocket 更新同步；✅ 低于 editor 的连接会被服务端丢弃更新；✅ `apps/web` 提供身份切换、文档列表、只读角色保护、文本编辑和在线成员显示。
- 如何验证：`pnpm check`；`pnpm --filter @collab/web build`；以 `PORT=8789 COLLAB_DB_PATH=m1-test.db pnpm --filter @collab/server dev` 启动后，HTTP 查询返回种子文档；Dan 的 WebSocket 更新被丢弃，Bob 的更新被接受并可重新查询；本地两个浏览器页实测 Bob 编辑后 Dan 窗口同步更新，Dan 的 textarea 为只读。
- 偏离与决定：使用内置 `node:sqlite` 运行时完成 SQLite repository，原因见 `docs/decisions.md`；WebSocket 使用 JSON 包装 Yjs update，原因见同文件。
- 已知问题：Web 客户端是轻量 textarea 编辑器，尚未使用 CodeMirror 6 的完整绑定；远程光标目前传输选区状态并展示在线成员，未绘制光标装饰；评论、建议和 agent 尚未实现。
- 下一步建议：M2 实现统一 Thread / Message / Suggestion 领域模型、审批生命周期、REST / SSE 和侧栏。

### M2 报告
- 完成情况：✅ `packages/review` 提供 Thread / Message / Suggestion / Batch 领域模型、权限策略、锚点解析、审批状态机、重叠建议失效和批量处理；✅ SQLite repository 与文档库共用同一连接，接受建议时文档替换和建议状态在同一事务中提交；✅ server 提供评论、回复、解决线程、创建/接受/拒绝建议、批量处理和 SSE 事件；✅ 服务端解析 `@displayName` 提及并跳过重名；✅ web 提供评论/建议侧栏、角色控制、接受/拒绝操作和原文→新文的 diff 预览。
- 如何验证：`pnpm check`；`pnpm --filter @collab/web build`；启动独立端口后验证创建线程、`@Polisher` 解析、建议接受、空 JSON POST、SSE `thread.created` 事件；停止并重启服务后，已接受的替换仍从 SQLite 恢复。
- 偏离与决定：编辑器仍是轻量 textarea，diff 目前在建议卡片中预览，尚未接入 CodeMirror 的正文装饰；事件总线仍是单进程内存实现，重启后不提供历史事件回放。
- 已知问题：M3 agent dispatcher、运行记录和 agent 标签页尚未实现；批量处理 API 已提供，web 尚未展示 Batch 卡片。
- 下一步建议：实现 agent 运行协议、上下文裁剪、超时/重试和前端 Agent 运行记录。

### M3 报告
- 完成情况：✅ `packages/agent` 提供 mock、openai-compatible、CLI 适配器接口；selection/window/full 上下文构建；JSON 输出提取与 edit 定位校验；有效角色过滤；超时、一次重试、失败反馈、运行记录和 `(agentId, threadId)` 单飞调度；✅ server 接入默认 mock agent、SQLite `agent_runs` / `agent_views`、`agent.status` SSE、Agent 查询接口；✅ web 增加 Agent 标签页。
- 如何验证：`pnpm check`；`pnpm --filter @collab/web build`；真实服务冒烟验证 `@Polisher 把「A」改成「B」` 生成待审建议，Alice 接受后正文从 `A` 变为 `B`，运行记录写入，Agent 状态回到 idle；Dan 以 commenter 触发时只收到回复，不生成建议。
- 偏离与决定：agent 配置默认从文档成员生成并使用 mock；OpenAI-compatible 与 CLI 适配器已实现可替换接口，运行时通过配置选择，尚未在本机调用真实模型或命令行工具。
- 已知问题：Agent 标签页当前只读展示；任务线程的 agent 指派与完整的人工修改并发演示留到 M4；人工修改 diff 的提示已写入上下文，但还没有独立的可视化记录。
- 下一步建议：补任务型评论的 agent 指派、Batch 进度界面、重新生成和人工修改感知的并发演示。

### M4 当前进展
- 已完成：review 层的 Batch 创建/进度/逐条处理与 accept-remaining/reject-remaining API；agent 的 effectiveRole、selection/full 上下文、人工快照、重叠建议 stale；stale agent suggestion 的 regenerate API 与 web 操作入口。
- 尚未完成：任务线程的 agent 指派控件和完整的并发演示；web 已显示 Batch 处理进度并提供「接受剩余 / 拒绝剩余」。

### M5 当前进展
- 已完成：README、API 速查和 `docs/demo.md` 已对应当前 server/web 启动方式、评论提及、mock agent、审批和 stale 演示流程。
- 尚未完成：独立的 `pnpm demo:seed` 重置脚本；当前首次启动 server 会按 `seed.config.json` 自动种子。

