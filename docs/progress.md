# 进度

### M0 报告
- 完成情况：✅ 已建立 pnpm workspace、TypeScript strict、Vitest、ESLint、Prettier、边界检查与六个包/应用目录。
- 如何验证：`pnpm check`。
- 偏离与决定：边界检查决定见 `docs/decisions.md`。
- 已知问题：M1 功能尚未完成。
- 下一步建议：实现 kernel、SQLite 文档存储、WebSocket 同步和最小 Web 客户端。

### M1 报告
- 完成情况：✅ `packages/kernel` 提供 Principal / Role / 表驱动 `can()`、Result、Clock / IdGenerator、Yjs `DocumentHandle` 与 Anchor 创建/解析；✅ `apps/server` 提供 SQLite 文档存储、种子配置、文档查询和 WebSocket 更新同步；✅ 低于 editor 的连接会被服务端丢弃更新；✅ `apps/web` 提供身份切换、文档列表、只读角色保护、文本编辑和在线成员显示。
- 如何验证：`pnpm check`；`pnpm --filter @collab/web build`；以 `PORT=8789 COLLAB_DB_PATH=m1-test.db pnpm --filter @collab/server dev` 启动后，HTTP 查询返回种子文档；Dan 的 WebSocket 更新被丢弃，Bob 的更新被接受并可重新查询。
- 偏离与决定：使用内置 `node:sqlite` 运行时完成 SQLite repository，原因见 `docs/decisions.md`；WebSocket 使用 JSON 包装 Yjs update，原因见同文件。
- 已知问题：Web 客户端是轻量 textarea 编辑器，尚未使用 CodeMirror 6 的完整绑定；远程光标目前传输选区状态并展示在线成员，未绘制光标装饰；评论、建议和 agent 尚未实现。
- 下一步建议：M2 实现统一 Thread / Message / Suggestion 领域模型、审批生命周期、REST / SSE 和侧栏。

