# 人机协同纯文本文档系统

这是按 `docs/SPEC.md` 构建的人机协同纯文本 demo。当前包含 Yjs 文档内核、角色权限、SQLite 持久化、WebSocket 协同同步、评论与建议审批、SSE 事件，以及默认 mock agent 的上下文、输出校验和待审建议闭环。

## 启动

```powershell
pnpm install
pnpm --filter @collab/server dev
pnpm --filter @collab/web dev
```

默认服务端地址为 `http://127.0.0.1:8787`，前端地址为 `http://127.0.0.1:5173`。开发前端会把 `/api` 和 `/ws` 代理到 8787；换端口时同时设置 `$env:PORT` 与 `$env:COLLAB_SERVER_PORT`。

种子用户和文档来自根目录的 `seed.config.json`。测试与检查：

```powershell
pnpm check
pnpm --filter @collab/web build
```

打开前端后可切换 Alice、Bob、Carol、Dan 和两个 agent。评论正文中写 `@Polisher 把「原文」改成「新文」`，默认 mock agent 会回复并创建待审建议；editor/owner 可以在「建议」标签接受或拒绝。更多接口和演示步骤见 [`docs/api.md`](docs/api.md) 与 [`docs/demo.md`](docs/demo.md)。

需要切换适配器时设置 `COLLAB_AGENT_CONFIG_JSON`，值为配置数组，例如 `[{"principalId":"polisher","adapter":{"type":"openai-compatible","baseUrl":"http://127.0.0.1:11434/v1","apiKeyEnv":"OLLAMA_API_KEY","model":"local"},"grantedRole":"editor","contextStrategy":"window"}]`。
