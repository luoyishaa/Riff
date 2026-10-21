# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

多人共同编辑、审阅和维护文档的写作者、评论者、审批者，以及负责配置 Agent 的文档 owner。Agent 以文档成员身份参与协作。

## Product Purpose

这是一个浏览器中的多人协作纯文本编辑器。人类通过选区评论、修改建议和审批共同维护正文；Agent 读取允许的上下文并提交可审的回复和建议。成功标准是团队能清楚知道谁提出了什么、建议作用于哪段文字、是否已经审批，以及 Agent 当前是否可用。

## Positioning

人和 Agent 共用同一套成员、角色、评论线程和建议审批机制。Agent 不绕过人工审批直接改写正文；本机已经登录的 Codex CLI、Claude Code 等命令行 Agent 可以作为可检测、可配置的适配器接入。

## Operating Context

主要运行在 Windows 本机开发环境中的浏览器和本地 server。文档正文通过 Yjs/WebSocket 协作同步，评论、建议、Agent 运行记录和配置由 server 管理，SQLite 保存本地数据。Agent 连接可能来自本机 CLI 登录状态，也可能来自用户输入的 API key。

## Capabilities and Constraints

- 角色包括 viewer、commenter、suggester、editor、owner；低于 editor 的人不能直接改正文。
- CodeMirror 6 提供正文编辑、选区和只读状态；选区可创建范围评论或建议。
- Agent 支持 mock、OpenAI-compatible 和 CLI 适配器，输出必须经过 JSON 协议、权限和锚点校验。
- CLI 探测只返回可用性和登录状态，不把本机 token 展示给浏览器；API key 默认只保存在当前 server 进程内，除非用户明确选择持久化。
- Agent 可以生成回复和建议，但正文修改必须经过人类审批。

## Evidence on Hand

- 项目设定和验收范围：`docs/SPEC.md`、`docs/demo.md`。
- 当前真实工作流：评论、选区建议、审批、Agent 运行和本机 SQLite 数据库。
- 当前实现及验证：`apps/web`、`apps/server`、`packages/agent`，以及 `corepack pnpm check` 的 62 个测试。

## Product Principles

1. 先让人看懂协作状态，再暴露配置细节。
2. Agent 的每次产出都要能追溯到线程、上下文和建议锚点。
3. 本机凭据只用于本机连接，浏览器只看到状态和结果。
4. 角色权限和人工审批优先于自动化便利。
5. 编辑、评论、建议和配置在桌面与窄屏下都保持可完成。

## Accessibility & Inclusion

支持键盘选区、清晰的焦点状态、足够的文字对比度、可读的状态文本和响应式布局；颜色不能成为区分 Agent 状态、建议状态或权限的唯一方式。
