# 决策记录

- 2026-10-15：使用 ESLint 配合自定义 `scripts/check-boundaries.mjs` 做包边界检查；这样可以在不引入额外图分析依赖的情况下让越界 import 在 `pnpm check` 中失败。
- 2026-10-15：M1 的 WebSocket 使用 JSON 包装的 Yjs binary update，并在服务端以 Y.Doc 重建 canonical 状态；这保持最小 sync 协议可读，客户端绑定不依赖领域包。
- 2026-10-15：当前 Node 24 运行时使用内置 `node:sqlite` 完成 M1 的 SQLite repository，避免 Windows 本机没有预编译 better-sqlite3 二进制时无法启动；repository API 保持在 `apps/server/src/infra` 边界内，后续可替换为 better-sqlite3。
- 2026-10-15：M2 的 `ReviewStore` 复用 `DocumentStore` 的 `DatabaseSync` 连接；这样建议接受路径中的 Yjs 文档更新与 review 状态更新可以由同一个 SQLite `BEGIN` / `COMMIT` 包住，避免两个连接造成部分提交。
- 2026-10-15：SSE 事件使用进程内递增 id 和 EventEmitter；这匹配当前单进程演示的范围，暂不引入队列或 Redis，也不承诺跨重启的事件重放。
