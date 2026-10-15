# API 速查

REST 请求用 `x-principal-id` 标识当前成员；审批类空 POST 可以省略 body，也可以发送 `{}`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/principals` | 身份列表 |
| GET | `/api/docs` / `/api/docs/:id` | 文档列表与正文 |
| GET/POST | `/api/docs/:id/threads` | 查询或创建线程 |
| POST | `/api/threads/:id/messages` | 回复线程 |
| POST | `/api/threads/:id/resolve` | 解决线程 |
| GET/POST | `/api/docs/:id/suggestions` | 查询或创建建议 |
| POST | `/api/suggestions/:id/accept` | 接受建议 |
| POST | `/api/suggestions/:id/reject` | 拒绝建议 |
| POST | `/api/suggestions/:id/regenerate` | 重新触发 stale agent 建议 |
| POST | `/api/batches/:id/accept-remaining` | 按顺序接受 Batch 剩余建议 |
| POST | `/api/batches/:id/reject-remaining` | 按顺序拒绝 Batch 剩余建议 |
| GET | `/api/docs/:id/agents` | Agent 状态与适配器 |
| GET | `/api/docs/:id/agents/:agentId` | 查询单个 Agent 配置（成员可查看） |
| PUT | `/api/docs/:id/agents/:agentId` | owner 更新 Agent 配置（适配器、授予角色、上下文策略） |
| DELETE | `/api/docs/:id/agents/:agentId` | owner 删除文档级配置并恢复 mock 默认值 |
| GET | `/api/docs/:id/agent-runs` | Agent 运行记录 |
| GET | `/api/docs/:id/events` | SSE；事件名与 data envelope 同步推送 |
| WS | `/ws/docs/:id?principal=...` | Yjs 文本同步与 awareness |

评论正文中的 `@displayName` 由服务端解析为成员 id；同名成员不会被自动解析。Agent 默认使用 mock 适配器，输出经过 JSON 协议和锚点校验后才会落为建议。
