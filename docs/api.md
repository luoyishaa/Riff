# API 速查

请求与响应类型定义在 `packages/protocol`（`requests.ts` 为 zod 请求模式，`responses.ts` 为响应类型，`realtime.ts` 为 WebSocket / SSE 消息）。REST 请求使用 HttpOnly `collab_session` cookie 标识当前账户；审批类空 POST 可以省略 body。`x-principal-id` 只在服务端设置 `COLLAB_DEV_AUTH_BYPASS=1` 时生效（测试与脚本用）。

错误统一为 `{ "error": { "code", "message" } }`：无会话 401，非成员或资源不存在 404，角色不足 403，其余业务失败 400（冲突类如重复账号为 409）。

## 账户

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册（`displayName`、`handle`、可选 `email`、`password` ≥ 8 位）；无密码的种子账户可用原 handle 认领一次 |
| POST | `/api/auth/login` · `/api/auth/switch` | 用 handle 或 email 加密码登录；替换当前浏览器会话，其他设备会话不受影响 |
| GET | `/api/auth/session` | 当前会话；未登录返回 `authenticated: false` |
| POST | `/api/auth/logout` | 撤销当前会话 |
| GET / PATCH | `/api/account` | 当前账户、所在项目与待处理邀请数；修改显示名、handle、email |
| GET | `/api/accounts/search?q=` | 按 handle、email 或显示名查找已注册的人类账户（不返回 email），用于邀请 |

## 项目（workspace）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/api/workspaces` | 当前账户的项目 / 新建项目 |
| GET | `/api/workspaces/:id` | 项目详情：成员（含可见的 Agent）、文档、本地项目状态 |
| PATCH / DELETE | `/api/workspaces/:id` | owner 重命名；删除需提交 `{ confirmTitle }` 与当前名称一致 |
| POST | `/api/workspaces/:id/documents` | editor 以上新建文档 |
| PUT / DELETE | `/api/workspaces/:id/members/:principalId` | owner 修改角色 `{ role }` 或移除成员；同时作用于该成员在项目内文档上的直接成员关系 |
| POST / GET | `/api/workspaces/:id/invitations` | owner 发出邀请 `{ identifier, role }`（handle 或 email）/ 查看邀请记录 |
| GET | `/api/invitations` | 发给当前账户的待处理邀请 |
| POST | `/api/invitations/:id/accept` · `/reject` | 接受或拒绝邀请 |
| POST / GET | `/api/workspaces/:id/local-project` | owner 绑定服务端目录 `{ path }` 或导入浏览器文件 `{ files }` / 查询状态 |
| POST | `/api/workspaces/:id/local-project/scan` | editor 以上重新扫描并协调 |

## 文档

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/api/docs` | 可见文档 / 新建文档（不指定项目时创建个人项目） |
| GET / DELETE | `/api/docs/:id` | 正文、当前角色、大纲与成员 / editor 以上删除（不删除本地源文件） |
| GET | `/api/docs/:id/outline` | 大纲（Markdown 取标题，TXT 取段落首行） |
| GET | `/api/docs/:id/versions` | 接受建议前后与恢复前的不可变版本 |
| POST | `/api/docs/:id/versions/:versionId/restore` | editor 以上恢复到某版本（先保存当前正文为安全版本） |
| POST | `/api/docs/:id/local-project/sync` | 写回映射文件；磁盘侧有修改时返回 `{ ok: false, file: { status: "conflict" } }` |

## 讨论与建议

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/api/docs/:id/threads` | 线程列表（含解析后的范围、未读）/ 新建线程 `{ kind, scope, agentId?, body? }`，`body` 同时发布第一条消息。范围 `scope` 为 `{ type: "range", start, end, quote? }`：带 `quote` 时服务端核对或在全文唯一出现处重新定位，无法确定时返回 409 `selection-changed` |
| POST | `/api/threads/:id/messages` | 回复；正文中的 `@显示名` 由服务端解析为提及 |
| POST | `/api/threads/:id/read` · `/resolve` | 标记已读 / 解决线程 |
| POST | `/api/messages/:id/withdraw` | 作者撤回消息（保留“已撤回”占位，不再返回正文） |
| GET / POST | `/api/docs/:id/suggestions` | 建议列表 / suggester 以上提交建议 |
| PATCH | `/api/suggestions/:id` | editor 以上在接受前修改建议文本 |
| POST | `/api/suggestions/:id/accept` · `/reject` · `/withdraw` · `/regenerate` | 审批、作者撤回、对过期的 Agent 建议重新运行 |
| POST | `/api/batches/:id/accept-remaining` · `/reject-remaining` | 按顺序处理一批建议的剩余部分 |

## Agent 与模型提供商

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/api/docs/:id/agents` | Agent 列表（状态、提供商、角色）/ commenter 以上新建 Agent `{ displayName, grantedRole, contextStrategy?, accessPolicy?, providerId?, model? }` |
| GET / PATCH / DELETE | `/api/docs/:id/agents/:agentId` | 查看 / 修改角色、上下文策略、交互权限、模型 / 恢复 mock 默认 |
| POST | `/api/docs/:id/agents/:agentId/bind-provider` | 绑定当前账户已连接的提供商 `{ providerId, model? }` |
| GET | `/api/docs/:id/agent-runs` | 运行记录（评测数据来源） |
| GET | `/api/model-providers?refresh=1` | 提供商目录与连接状态（CLI 探测结果缓存 30 秒，`refresh=1` 重新检测） |
| POST / DELETE | `/api/model-providers/:providerId(/connect)` | 连接 API key 提供商 `{ apiKey, model, baseUrl? }`（只保存在服务进程内）/ 断开 |
| GET | `/api/model-providers/:providerId/models` | 已连接提供商的模型目录 |

Agent 的连接只能通过提供商目录绑定。自定义命令行 Agent 或环境变量中的 key 只能由服务运营者在启动时用 `COLLAB_AGENT_CONFIG_JSON` 配置，例如 `[{"principalId":"polisher","adapter":{"type":"openai-compatible","baseUrl":"http://127.0.0.1:11434/v1","apiKeyEnv":"OLLAMA_API_KEY","model":"local"},"contextStrategy":"window"}]`；Agent 的角色始终是它的成员角色。

## 实时通道

| 通道 | 路径 | 内容 |
| --- | --- | --- |
| SSE | `GET /api/docs/:id/events` | `thread.*`、`message.*`、`suggestion.*`、`batch.created`、`document.changed` 只带变更对象 id；`agent.status` 带 `{ agentId, threadId, state, error?, errorKind?, range? }`；`members.changed`（无数据）表示项目成员、角色或 Agent 有变化，客户端重新拉取文档与 Agent |
| WS | `/ws/docs/:id` | 客户端发 `{ type: "sync", update }`（增量 Yjs 更新，低于 editor 的连接被丢弃）与 `{ type: "awareness", clientId, update }`；服务端发 `sync`、`awareness`、`awareness-leave` 与在线成员 `members` |
