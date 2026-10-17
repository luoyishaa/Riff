# API 速查

REST 请求默认使用 HttpOnly `collab_session` cookie 标识当前成员；审批类空 POST 可以省略 body，也可以发送 `{}`。旧 `x-principal-id` 只在服务端显式设置 `COLLAB_DEV_AUTH_BYPASS=1` 时兼容。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册人类账户（`displayName`、唯一 `handle`、可选 `email`、`password`，密码至少 8 位）；成功后写入 HttpOnly 会话 cookie |
| POST | `/api/auth/login` | 使用 `handle` 或 `email` 加密码登录并写入 HttpOnly 会话 cookie |
| POST | `/api/auth/switch` | 使用本地保存的 `handle` / `email` 与密码直接切换当前浏览器会话；其他设备会话保持有效 |
| GET | `/api/auth/session` | 恢复当前 cookie 会话；未登录返回 `authenticated: false` |
| POST | `/api/auth/logout` | 撤销当前 cookie 会话并清除浏览器 cookie |
| GET | `/api/principals` | 当前登录用户可见的人类账户和 Agent 摘要；需要 cookie 会话，不返回 email |
| POST | `/api/principals` | 已停用（默认返回 `410`）；开发兼容模式才允许旧身份目录写入，真实注册请使用 `/api/auth/register` |
| GET | `/api/accounts/search?q=...` | 按账号 `handle`、未验证 `email` 或显示名查找已注册的人类账户；需要当前人类身份 |
| GET/PATCH | `/api/account` | 查询或更新当前 cookie 会话对应的人类资料（显示名、账号 `handle` 与未验证 `email`） |
| POST | `/api/account/switch` | 已停用（默认返回 `410`）；真实账户通过 `/api/auth/login` 切换会话 |
| POST | `/api/account/logout` | 旧路径仅保留兼容，真实登出请使用 `/api/auth/logout` |
| GET | `/api/agent-providers` | 探测本机 Codex CLI / Claude Code 安装与登录状态；不返回 token |
| GET | `/api/model-providers` | 查询当前账户的统一模型提供商目录，返回 `connected` / `not-connected` / `unavailable` 状态和可展示模型；不返回 API key 或 OAuth token |
| POST | `/api/model-providers/:providerId/connect` | 连接 OpenAI API、OpenRouter、DeepSeek 或自定义 OpenAI-compatible 提供商；提交 `{ apiKey, model, baseUrl? }`，凭据仅保留在当前 server 进程 |
| DELETE | `/api/model-providers/:providerId` | 断开当前账户的进程内 API-key 提供商连接 |
| GET | `/api/model-providers/:providerId/models` | 查询已连接 API-key 提供商的模型目录；供应商不可用时回退到连接时的模型 |
| GET/POST | `/api/workspaces` | 查询当前身份可见的文档空间，或创建新的文档空间 |
| PATCH | `/api/workspaces/:id` | owner 重命名文档空间，提交 `{ title }` |
| DELETE | `/api/workspaces/:id` | owner 删除文档空间及其文档；必须提交 `{ confirmTitle: "当前项目名称" }` 精确确认 |
| GET | `/api/workspaces/:id` | 查询空间成员和其中的文档 |
| POST | `/api/workspaces/:id/documents` | 在空间内创建纯文本（UTF-8）文档 |
| POST | `/api/workspaces/:id/local-project` | owner 绑定服务端可访问的绝对目录，或导入浏览器提供的 `.txt` / `.md` 文件清单并扫描映射 |
| GET | `/api/workspaces/:id/local-project` | 查询本地项目来源、规范化路径和文件同步状态 |
| POST | `/api/workspaces/:id/local-project/scan` | 重新扫描已绑定的服务端目录；editor 以上可调用 |
| GET/POST | `/api/workspaces/:id/members` | 查询空间成员（GET 通过空间详情）或邀请已有身份并授予角色 |
| PUT/DELETE | `/api/workspaces/:id/members/:principalId` | 更新或移除空间成员；仅 owner |
| GET | `/api/invitations` | 查询当前人类身份收到的待处理空间邀请 |
| POST | `/api/workspaces/:id/invitations` | owner 创建待处理邀请；推荐提交 `{ identifier: "account-handle", role }`，服务端按数据库账户标识解析目标；旧 `{ principalId, role }` 仅为兼容 |
| GET | `/api/workspaces/:id/invitations` | owner 查询该空间的邀请记录 |
| POST | `/api/invitations/:id/accept` / `/reject` | 接受或拒绝发给当前身份的邀请；接受后加入空间 |
| GET/POST | `/api/docs` | 查询文档列表或创建文档（未指定空间时自动创建个人空间） |
| GET | `/api/docs/:id` / `/api/docs/:id/outline` | 文档正文、继承后的成员和纯文本段落大纲 |
| POST | `/api/docs/:id/local-project/sync` | 将当前文档内容写回已映射文件；检测到外部并发修改时返回 `conflict` 并停止覆盖 |
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
| POST | `/api/docs/:id/agents` | commenter 以上操作者创建 Agent principal、成员关系与 provider 配置；授予角色不超过操作者，API key 仅当前 server 会话保存 |
| GET | `/api/docs/:id/agents/:agentId` | 查询单个公开 Agent 配置；private Agent 仅其 owner 或文档 owner 可查看 |
| PUT | `/api/docs/:id/agents/:agentId` | Agent owner 或文档 owner 更新 Agent 配置（适配器、授予角色、上下文策略） |
| POST | `/api/docs/:id/agents/:agentId/connect` | Agent owner 或文档 owner 连接 Codex / Claude CLI 或 OpenAI-compatible API；API key 只在当前 server 进程内使用 |
| POST | `/api/docs/:id/agents/:agentId/bind-provider` | 将 Agent 绑定到当前账户已连接的统一提供商；提交 `{ providerId, model?, grantedRole?, contextStrategy?, accessPolicy? }`，API key 由服务端进程内连接读取 |
| DELETE | `/api/docs/:id/agents/:agentId` | Agent owner 或文档 owner 删除文档级配置并恢复 mock 默认值 |
| GET | `/api/docs/:id/agent-runs` | Agent 运行记录 |
| GET | `/api/docs/:id/events` | SSE；事件名与 data envelope 同步推送 |
| WS | `/ws/docs/:id` | 通过 cookie 会话鉴权的 Yjs 文本同步与 awareness |

评论正文中的 `@displayName` 由服务端解析为成员 id；同名成员不会被自动解析。Agent 默认使用 mock 适配器，输出经过 JSON 协议和锚点校验后才会落为建议。
