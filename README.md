# 人机协同纯文本文档系统

这是按 `docs/SPEC.md` 构建的人机协同纯文本 demo。当前包含 Yjs 文档内核、角色权限、SQLite 持久化、WebSocket 协同同步、评论与建议审批、SSE 事件，以及默认 mock agent 的上下文、输出校验和待审建议闭环。

## 启动

```powershell
corepack pnpm install
corepack pnpm --filter @collab/server dev
corepack pnpm --filter @collab/web dev
```

默认服务端地址为 `http://127.0.0.1:8787`，前端地址为 `http://127.0.0.1:5173`。开发前端会把 `/api` 和 `/ws` 代理到 8787；换端口时同时设置 `$env:PORT` 与 `$env:COLLAB_SERVER_PORT`。

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

打开前端后可切换 Alice、Bob、Carol、Dan 和两个 agent。评论正文中写 `@Polisher 把「原文」改成「新文」`，默认 mock agent 会回复并创建待审建议；editor/owner 可以在「建议」标签接受或拒绝。更多接口和演示步骤见 [`docs/api.md`](docs/api.md) 与 [`docs/demo.md`](docs/demo.md)。

需要切换适配器时可以在 Agent 标签页由 owner 保存文档级配置；删除配置会恢复安全的 mock/window 默认值。也可以在启动时设置 `COLLAB_AGENT_CONFIG_JSON`，值为配置数组，例如 `[{"principalId":"polisher","adapter":{"type":"openai-compatible","baseUrl":"http://127.0.0.1:11434/v1","apiKeyEnv":"OLLAMA_API_KEY","model":"local"},"grantedRole":"editor","contextStrategy":"window"}]`。
