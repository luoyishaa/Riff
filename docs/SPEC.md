# SPEC：人机协同纯文本文档系统（第一代 demo）

## 1. 目标与范围

**做什么：** 一个浏览器中的多人协作纯文本编辑器。人和 AI agent 同为「用户」，在同一份文档上通过评论线程、修改建议和审批协作。agent 响应评论，给出可审的修改建议，而不是直接改写正文。

**成功标准：**

1. 能无手工干预地跑通 §11 的 demo 场景。
2. 两个以上浏览器并发编辑同一文档，内容收敛。
3. 更换 agent 的接入方式（mock / API / 命令行）不需要改动 `agent` 包之外的任何代码。

**范围：** 纯文本（UTF-8，`\n` 换行）。不做的事见 `AGENTS.md` §5。

---

## 2. 核心概念

| 概念 | 说明 |
| --- | --- |
| Principal | 参与者。`kind` 为 `human` 或 `agent`。agent 有 `ownerId`（配置它的人，可为空）。系统里人和 agent 共用同一套身份、成员与权限机制 |
| Role | 文档级角色，从低到高：`viewer` < `commenter` < `suggester` < `editor` < `owner` |
| Document | 文本内容由 kernel 管理，**单一 canonical 状态**，没有分支、fork、merge |
| Anchor | 对一段文本的稳定引用：Yjs RelativePosition（起、止）+ 引文 `quote` |
| Thread | 评论串。`scope` 为 `range`（带 Anchor）或 `document`（整篇）；`kind` 为 `discussion` 或 `task` |
| Message | 串内的一条消息，可 `@提及` 成员（人或 agent） |
| Suggestion | 对一段文本的替换提议，经审批后才生效 |
| Batch | 同一次 agent 运行产出的一组 Suggestion，可整体查看进度、批量审批 |
| AgentRun | 一次 agent 调用的完整记录（同时是评测数据来源，见 §12） |

**一个关键的统一：** 评论、任务、文档级对话都是 `Thread`，只是 `scope` 与 `kind` 不同。不要为它们各做一套模型。

---

## 3. 架构与包边界

```
apps/server        Fastify + ws + SSE。组装各包，包含 SQLite 的 repository 实现
apps/web           React 18 + Vite + CodeMirror 6
packages/protocol  zod 线上协议（REST / SSE 的请求响应类型）
packages/kernel    Principal / Role / 权限、Document（封装 Yjs）、Anchor
packages/review    Thread / Message / Suggestion / Batch、审批策略、生命周期
packages/agent     Adapter 接口与实现、调度器、上下文策略、输出协议
```

**依赖方向（只能向左依赖）：**

`kernel` ← `review` ← `agent` ← `apps/server`
`protocol` ← `apps/server`、`apps/web`
`apps/web` 不得依赖 `kernel` / `review` / `agent`。

**硬规则：**

- Yjs 只出现在 `kernel` 内部，以及 `apps/web` 的编辑器绑定里。`review` 和 `agent` 通过 kernel 暴露的 `DocumentHandle` 工作（取文本、创建/解析 Anchor、应用编辑、订阅变化）。
- 领域包（kernel / review / agent）不做 IO，不直接取时间和随机数；通过 `Clock`、`IdGenerator`、repository 接口注入。
- SQLite 的 repository 实现放在 `apps/server/src/infra`。
- 边界由 `pnpm check` 强制：用 ESLint `no-restricted-imports` 或 dependency-cruiser，二选一，在 decisions.md 记录。
- 进程内事件总线（类型化的 EventEmitter）连接 review、agent 与 SSE 推送，不引入队列或 Redis。

**技术栈：** TypeScript strict、Node ≥ 20、pnpm workspace、Vitest、ESLint + Prettier、zod、Fastify、ws、yjs、y-protocols、y-codemirror.next、better-sqlite3（手写 SQL + 简单迁移）、React 18、Vite、CodeMirror 6。

**同步服务：** 用 y-protocols 实现最小的 sync + awareness（不引入完整的 y-websocket 服务端，除非明显更省事，并在 decisions.md 说明）。权限低于 `editor` 的连接，其文档更新消息必须被丢弃。

---

## 4. 领域模型

```
Principal    { id, kind: 'human'|'agent', displayName, ownerId? }
Membership   { docId, principalId, role }
Anchor       { start: RelPos, end: RelPos, quote: string }
Thread       { id, docId, scope: {type:'range', anchor} | {type:'document'},
               kind: 'discussion'|'task', status: 'open'|'resolved', createdBy, createdAt }
Message      { id, threadId, authorId, body, mentions: PrincipalId[], createdAt }
Suggestion   { id, docId, threadId?, batchId?, authorId, anchor, newText, rationale?,
               status: 'pending'|'accepted'|'rejected'|'stale',
               decidedBy?, decidedAt?, createdAt }
Batch        { id, threadId, createdBy, createdAt }          // 进度由其下 Suggestion 的状态统计
AgentConfig  { principalId, adapter: AdapterConfig, grantedRole, contextStrategy }
AgentRun     { id, agentId, docId, threadId, requesterId, strategy, startedAt, durationMs,
               inputChars, outputValid, retries, error?, suggestionIds }
AgentView    { agentId, docId, textSnapshot, takenAt }      // 该 agent 上次看到的文本
ApprovalPolicy { docId, rules: [{ match: {authorKind?, authorId?, maxChangedChars?},
                                  action: 'auto-accept'|'require-approval' }] }
```

- 插入是空区间的替换，删除是 `newText` 为空的替换。内部统一归一化为「替换」。
- `mentions` 在服务端由消息正文中的 `@displayName` 对照文档成员解析得到，客户端不自行提交。
- agent 的配置来自一个配置文件（`agents.config.json`，启动时加载），不存数据库。某个文档是否启用某个 agent，由该 agent 是否是该文档成员决定。

---

## 5. 权限与审批

**动作所需的最低角色：**

| 动作 | 最低角色 |
| --- | --- |
| 查看文档、线程、建议 | viewer |
| 新建线程、发消息 | commenter |
| 创建修改建议 | suggester |
| 直接编辑正文 | editor |
| 接受 / 拒绝建议 | editor |
| 管理成员、审批策略 | owner |

实现为一个表驱动的纯函数 `can(role, action)`。

**agent 的有效权限：** 一次 agent 运行的有效角色 = `min(agent 被授予的角色, 触发这次运行的人的角色)`。触发者是触发运行的那条消息的作者。

- 有效角色 ≥ `suggester`：agent 的修改以建议形式提交。
- 有效角色 = `commenter`：agent 只能回复，它给出的修改被丢弃，并在回复末尾说明原因。
- 有效角色 < `commenter`：拒绝运行，并在线程里留一条可见的说明。

**审批策略：** 建议创建时求值 `approvalDecision(policy, suggestion, authorEffectiveRole)`：

- 仅当作者有效角色 ≥ `editor` 且匹配到 `auto-accept` 规则时，才自动接受（走与手动接受相同的路径，包括锚点校验）。
- 其余一律 `pending`，等待 editor 以上角色审批。
- 默认策略：对所有人 `require-approval`。

低于 `editor` 的人类用户不能直接改正文（编辑器只读），他们通过「建议修改」提交。

---

## 6. 锚点与建议的生命周期

**创建锚点：** 由绝对区间 `[s, e)` 生成起止两个 Yjs RelativePosition，并保存 `quote = text.slice(s, e)`。注意起点与终点的 `assoc` 取向：在区间两端插入文字时，既不能被吞进锚点，也不能把锚点撑开。这个行为用测试钉死。

**解析锚点** `resolve(anchor, currentText)`：

1. 解析相对位置得到 `[s, e)`；若 `text.slice(s, e) === quote`，结果为 `exact`。
2. 否则在全文中查找 `quote`：唯一命中则 `relocated`（并更新锚点）；没有或多处命中则 `detached`。

`detached` 的线程不隐藏，在界面的「未定位」区域展示。

**建议状态机：** `pending → accepted | rejected | stale`。

- 接受 `accept(id, deciderId)`：校验权限 → 解析锚点 → 非 `exact` / `relocated` 则标记 `stale` 并返回业务错误 → 否则在一个事务里应用替换，应用时记录 `{principalId: deciderId, suggestionId}` 作为变更来源。
- 文档变化后（防抖），服务端对该文档的所有 `pending` 建议重新求值，解析失败的标记为 `stale` 并推送事件。接受一条建议后，与它重叠的其它建议会因此自然变为 `stale`。
- `stale` 的建议可以「重新生成」：对 agent 作者的建议，在同一线程里用相同 agent 重新发起一次运行。

---

## 7. Agent 层

### 7.1 触发

- 线程里的新消息 `@提及` 了某个 agent：触发该 agent。
- 该 agent 已参与的线程里，出现人类的新回复：触发该 agent。
- `kind: 'task'` 的线程：创建时必须指定 agent（`@` 或指派下拉框），创建即触发。
- agent 自己发的消息，以及 agent 之间的 `@`，一律不触发（避免循环）。

### 7.2 上下文策略（可插拔，评测要用）

接口 `ContextStrategy.build(input): AgentContext`。实现三种：

| 策略 | 内容 |
| --- | --- |
| `selection` | 选区 + 线程全部消息 |
| `window`（默认） | 选区 ± N 个段落 + 全文大纲（每个段落首行前 60 字）+ 线程消息 + 自上次以来的人工修改（§7.6） |
| `full` | 全文 + 线程消息 + 自上次以来的人工修改 |

总长度超过 `maxChars` 时，从距离选区最远的内容开始截断。`document` 范围的线程，`selection` 与 `window` 退化为全文。

### 7.3 输出协议

agent 必须返回一个 JSON 对象：

```json
{
  "reply": "给人看的解释，必填",
  "edits": [
    {
      "op": "replace",
      "quote": "要被替换的原文，必须逐字出现在文档中",
      "newText": "替换后的文本",
      "contextBefore": "可选，quote 之前的若干字，用于消歧",
      "contextAfter": "可选，quote 之后的若干字，用于消歧",
      "rationale": "可选，一句话理由"
    }
  ]
}
```

- `op: replace`：把 `quote` 换成 `newText`。
- `op: delete`：删除 `quote`。
- `op: insert`：在 `quote` 之后插入 `newText`，`quote` 本身不变。

**校验规则**（agent 层的纯函数，与适配器无关）：

1. 从原始文本中取出第一个顶层 JSON 对象（容忍代码围栏和前后多余文字），再用 zod 校验结构。
2. 每个 edit 的 `quote` 必须在「允许区域」内逐字且唯一地命中；有 `contextBefore/After` 时用它们消歧。允许区域是上下文中提供给 agent 的文本范围。
3. edits 之间不得重叠；数量上限 50，超出的被丢弃并在回复中说明。
4. 失败处理：整体不合法时，把校验错误附在提示里**重试一次**；仍不合法，则在线程里留下可见的失败说明。部分 edit 合法时，保留合法部分，并在回复末尾列出未能定位的修改。

`reply` 始终作为 agent 的消息发布到线程；合法的 edits 经有效角色过滤（§5）后落为 Suggestion。

### 7.4 适配器

适配器是**纯文本进、纯文本出**，对输出协议一无所知，协议的解析与校验都在适配器之上完成：

```ts
interface AgentAdapter {
  readonly id: string
  run(req: { system: string; user: string }, opts: { signal: AbortSignal }): Promise<{ text: string }>
}
```

实现三个：

- **`mock`**：用于测试与离线演示。通用的确定性规则，写在文档里：读取线程最新的人类消息，若形如 `replace "A" with "B"` 或 `把「A」改成「B」`，则对允许区域内 A 的每一处出现生成 replace；否则只回复「收到：…」而不产生 edits。它是真正的 `AgentAdapter` 实现，不是写死的返回值。
- **`openai-compatible`**：配置 `baseUrl`、密钥所在的环境变量名、`model`；请求 `chat/completions`，可用时启用 JSON 模式；带超时。可对接 OpenAI、DeepSeek、Ollama 等。
- **`cli`**：配置命令与参数模板（`{{prompt}}` 占位，或通过 stdin 传入），读取 stdout 作为输出；带超时，超时后终止子进程。用来接入 Codex、Claude Code 等命令行 agent。示例配置里的命令行参数仅作示例，**不得凭记忆假定 flag**，以本机 `--help` 为准。

提示词模板放在 `packages/agent/src/prompts`，包含：角色说明、输出协议、规则（最小修改、不要动允许区域之外的文本、理由一句话、与原文语言一致）、以及上下文。

### 7.5 调度与并发

- `AgentDispatcher` 订阅领域事件，按 §7.1 决定是否运行。
- 每个 `(agentId, threadId)` 单飞：运行期间的新触发最多排队一个（后来者覆盖先来者）。
- 超时默认 120 秒。运行开始与结束时发出 `agent.status` 事件 `{agentId, threadId, state: 'working'|'idle'|'failed', range?}`，前端据此展示「正在处理」。
- 运行期间线程被解决或删除：丢弃结果。
- 任何失败都必须在线程里以 agent 的名义留下一条简短的可见消息，不得静默失败。

### 7.6 感知人工修改

每次运行后，保存 agent 看到的文本快照（`AgentView`）。下一次运行时，把快照与当前文本的词级 diff（最多 2000 字，超出则截断并注明）作为「自你上次查看以来，人类做了这些修改」放入上下文，并在提示中要求不要撤销这些修改。

### 7.7 运行记录

每次运行写一条 `AgentRun`。字段设计见 §4，它同时是评测数据来源（§12）。

---

## 8. 任务型评论

`kind: 'task'` 的线程，范围可以是选区或整篇。agent 返回多条 edits 时，生成一个 `Batch`：

- 界面展示 Batch 卡片：进度（已处理 k / n）、逐条 accept / reject、「接受剩余」「拒绝剩余」。
- 批量接受按条依次走 §6 的 accept 流程，返回每一条的结果；互相重叠的建议，后面的会因此变为 stale，这是预期行为。
- 单次运行最多 50 条 edits（§7.3）。

---

## 9. 前端

- **顶栏：** 身份切换下拉框（demo 用户）、文档标题、协作者头像栏。人是圆形头像；agent 是圆角方形并带「AI」标记，处于 `working` 时显示加载状态。
- **编辑器：** CodeMirror 6。角色 ≥ `editor` 可编辑，其余只读。显示远程光标（颜色与名字）、评论范围的下划线、待审建议的行内 diff（原文删除线 + 新文绿色）及 Accept / Reject；`stale` 的建议置灰。
- **选区工具条：** 「评论」（commenter 及以上）、「建议修改」（suggester 及以上，输入新文本后提交）。
- **右侧栏三个标签：**
  - 「评论」：线程列表与当前线程。输入框支持 `@` 自动补全成员；可勾选「作为任务」并选择指派的 agent。
  - 「建议」：建议与 Batch 卡片，显示状态与进度。
  - 「Agent」：该文档的 agent 成员列表、其适配器类型、当前状态；owner 可以增删 agent 成员（即「选择 agent」）。
- 「文档对话」是 `scope: document` 的线程，单独放一个入口。agent 在其中的回复可以带 edits。
- 样式保持简洁，不引入 UI 组件库，除非明显省事并在 decisions.md 记录。不做动画。
- 状态管理：不引入状态库。用 hooks 订阅 SSE，事件到达后重新拉取。

---

## 10. 里程碑

**M0：脚手架与边界**
monorepo、tsconfig、lint、Prettier、Vitest；`pnpm check`（类型检查 + lint + 测试 + 边界检查）；各包空壳与导出；`docs/decisions.md`、`progress.md`、`ideas.md`。
*验收：* `pnpm check` 通过；手动加一条越界 import 能让 check 失败（验证一次即可，不保留）。

**M1：内核与协同编辑**
Principal / Role / `can()`；`DocumentHandle`（Yjs 封装）与 Anchor 创建/解析；DocumentStore 的 SQLite 实现（追加 Yjs 更新，不做压缩）；服务端的同步端点与权限过滤；文档增删查；配置文件中的种子用户；Web：身份切换、文档列表、编辑器、远程光标。
*验收：* 两个浏览器同时编辑同一文档，刷新后内容保留；viewer 无法输入；服务端丢弃低权限连接的更新。

**M2：评论与建议**
review 包的全部领域逻辑与 SQLite 实现；REST 与 SSE；@ 提及；前端侧栏与行内 diff。
*验收：* A 评论、B 回复；suggester 提交建议；editor 接受；文本变化后相关建议变为 stale；被 @ 的人收到事件。

**M3：Agent 最小闭环**
适配器接口与三个实现；上下文策略 `window`；输出协议与校验；调度器（单飞、超时、失败反馈）；`agent.status`；Agent 标签页。
*验收：* 用 mock 适配器，评论 `@Polisher 把「A」改成「B」` 后出现待审建议，接受后正文更新；切换为 openai-compatible 或 cli 适配器，仅改配置，流程不变（真实模型的验证以手动步骤写入文档；自动化测试用本地假 HTTP 服务与假命令行脚本）。

**M4：差异化功能**
任务型评论与 Batch；审批策略与「有效权限 = min」；人工修改感知；建议的「重新生成」；`selection` 与 `full` 两种上下文策略。
*验收：* 「统一术语」任务产生一批建议，可批量处理；commenter 触发的 agent 只回复不改；agent 工作中他人修改同一句，建议变 stale 并可重新生成。

**M5：Demo 打磨**
种子脚本 `pnpm demo:seed`；`docs/demo.md` 逐步对应 §11；README（启动方式、架构图、配置 agent 的方法）。

**M6（可延后）：评测支撑** 见 §12。

---

## 11. Demo 场景

种子数据：Alice（owner）、Bob（editor）、Carol（suggester）、Dan（commenter）；agent：Polisher（默认 mock，可改配置换成真实模型）、Reviewer。文档：一篇约 1500 字、含重复术语的中文说明文。

| 步骤 | 场景 | 展示 |
| --- | --- | --- |
| S1 | 三个浏览器窗口同时打开，头像栏里有人和 agent，光标各自不同 | 统一的用户身份、协同编辑 |
| S2 | Bob 选中一句话评论 `@Polisher …`，该句旁出现「正在处理」，随后出现 diff 与理由，Bob 点 Accept | 锚定评论、建议、在场状态 |
| S3 | Alice 新建任务「统一术语」，Polisher 返回一批建议，进度条显示，Alice 逐条过几条后「接受剩余」 | 任务型评论、批量审批 |
| S4 | Carol（suggester）`@Polisher` 提出修改，建议为「待审批」，Alice 通过；Dan（commenter）`@Polisher` 只得到回复 | 有效权限、审批 |
| S5 | 在 Agent 标签页切换 Reviewer，用它处理下一条评论 | 选择 agent |
| S6 | Alice 直接改了一个术语，Polisher 在评论中提醒还有两处未同步 | 人工修改感知 |
| S7 | Polisher 处理某句期间，Bob 改了同一句，建议变为 stale，点击「重新生成」 | 并发保护 |

---

## 12. 评测支撑（M6，可延后）

- `agent_runs` 表已经记录了延迟、输入长度、输出是否合法、重试次数；建议的 accept / reject 状态可与之关联，由此得到「采纳率」。
- `pnpm eval:contexts <taskset.json>`：对任务集中的每个任务，在三种上下文策略下各运行一遍，输出 CSV（策略、任务、输出是否合法、重试次数、延迟、输入字符数、建议数）。
- `pnpm eval:concurrency`：N 个模拟客户端对同一文档随机编辑、评论、提交建议若干秒，输出：是否收敛；锚点解析结果中 `exact` / `relocated` / `detached` 的数量；过期建议被检出的比例。

---

## 附：API 概览（初稿，可调整；实现后在 `docs/api.md` 同步）

所有 REST 请求通过请求头 `x-principal-id` 标识身份。

```
POST   /api/docs                          GET  /api/docs         GET /api/docs/:id
GET    /api/docs/:id/threads              POST /api/docs/:id/threads
POST   /api/threads/:id/messages          POST /api/threads/:id/resolve
POST   /api/docs/:id/suggestions
POST   /api/suggestions/:id/accept|reject|regenerate
POST   /api/batches/:id/accept-remaining|reject-remaining
GET    /api/docs/:id/agents               PUT  /api/docs/:id/agents/:agentId
GET    /api/docs/:id/events               (SSE)
WS     /ws/docs/:id?principal=...         (Yjs sync + awareness)
```
