# 人机协同纯文本文档系统

这是按 `docs/SPEC.md` 构建的第一代 demo。M1 提供 Yjs 文档内核、角色权限、SQLite 持久化、WebSocket 协同同步和最小浏览器界面。

## 启动

```powershell
pnpm install
pnpm --filter @collab/server dev
pnpm --filter @collab/web dev
```

默认服务端地址为 `http://127.0.0.1:8787`，前端地址为 `http://127.0.0.1:5173`。如果 8787 已被其他本地服务占用，可设置 `$env:PORT='8789'`，同时修改前端 Vite 代理目标。

种子用户和文档来自根目录的 `seed.config.json`。测试与检查：

```powershell
pnpm check
pnpm --filter @collab/web build
```
