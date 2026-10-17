# 人机协同纯文本文档系统

这是按 `docs/SPEC.md` 构建的人机协同纯文本 demo。当前包含 Yjs 文档内核、角色权限、SQLite 持久化、WebSocket 协同同步、评论与建议审批、SSE 事件，以及默认 mock agent 的上下文、输出校验和待审建议闭环。

## 启动

```powershell
corepack pnpm install
corepack pnpm --filter @collab/server dev
corepack pnpm --filter @collab/web dev
```

默认服务端地址为 `http://127.0.0.1:8787`，前端地址为 `http://127.0.0.1:5173`。开发前端会把 `/api` 和 `/ws` 代理到 8787；换端口时同时设置 `$env:PORT` 与 `$env:COLLAB_SERVER_PORT`。当前服务端默认把 SQLite 文件写入 `apps/server/collab.db`，也可以通过 `$env:COLLAB_DB_PATH` 指定路径。

种子用户和文档来自根目录的 `seed.config.json`。测试与检查：

```powershell
corepack pnpm check
corepack pnpm --filter @collab/web build
```

M6 评测脚本不依赖正在运行的服务：

```powershell
corepack pnpm eval:contexts eval/taskset.json --out eval/context-results.csv
corepack pnpm eval:concurrency --clients 4 --steps 200 --seed 42 --out eval/concurrency-results.json
```

`eval:contexts` 对每个任务分别构建 `selection`、`window`、`full` 上下文，运行确定性的 mock 输出协议校验，并输出 `strategy,task,validity,retries,latency,inputChars,suggestionCount` CSV。任务集可以是数组，也可以是包含 `tasks` 数组的 JSON 对象；可用 `rawOutputs` 为单个任务提供“第一次失败、第二次重试”的输入。`eval:concurrency` 使用可复现的种子模拟多个客户端的编辑、评论和建议，报告最终是否收敛、锚点 `exact` / `relocated` / `detached` 数量以及过期建议检出比例。`--steps` 表示事件数，不等待真实时间；同一 `--seed` 会生成同一事件序列。

打开前端后先注册或登录账户。旧种子账户没有密码，第一次使用时可以在注册页用既有 handle（例如 `alice`）认领，它会保留原有项目成员关系。项目邀请按真实账号 handle 或 email 发送，被邀请者登录后在“待处理邀请”中接受。选中文字后可直接评论或提交建议；评论正文中写 `@Polisher 把「原文」改成「新文」`，默认 mock agent 会回复并创建待审建议；editor/owner 可以在「建议」标签接受或拒绝。更多接口和演示步骤见 [`docs/api.md`](docs/api.md) 与 [`docs/demo.md`](docs/demo.md)。

项目 owner 可以从顶部“模型”入口管理统一的提供商目录：Codex CLI、Claude Code、OpenRouter、DeepSeek、OpenAI API 和自定义 OpenAI-compatible 接口都会显示连接状态。连接完成后，在成员面板的 Agent 配置中选择当前 Agent 使用的提供商和模型，并设置 `public` / `private` 交互权限。页面会检测本机 CLI 的安装和登录状态；CLI 连接沿用本机登录，API key 只保存在当前 server 进程，重启后需重新连接。DeepSeek 使用官方 `https://api.deepseek.com` 地址和 `deepseek-flash` 默认模型；OpenRouter 和自定义接口需要填写服务商提供的模型 ID。启动配置仍支持 `COLLAB_AGENT_CONFIG_JSON`，例如 `[ {"principalId":"polisher","adapter":{"type":"openai-compatible","baseUrl":"http://127.0.0.1:11434/v1","apiKeyEnv":"OLLAMA_API_KEY","model":"local"},"grantedRole":"editor","contextStrategy":"window"} ]`。

## 本地项目模式

在空间侧栏的“本地项目”面板中，可以绑定服务端可访问的绝对目录。服务端会递归扫描其中的 UTF-8 `.txt` 和 `.md` 文件，把相对路径映射为空间文档，并在协作编辑后用原子替换写回原文件。浏览器支持 File System Access API 时，文件夹选择器也能在当前页面写回原文件；不支持时会退化为一次性导入，需要填写服务端目录路径才能持续同步。完整接口、冲突状态和权限边界见 [`docs/local-project.md`](docs/local-project.md)。
