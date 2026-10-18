# 进度

### M0 报告
- 完成情况：✅ 已建立 pnpm workspace、TypeScript strict、Vitest、ESLint、Prettier、边界检查与六个包/应用目录。
- 如何验证：`pnpm check`。
- 偏离与决定：边界检查决定见 `docs/decisions.md`。
- 已知问题：M1 功能尚未完成。
- 下一步建议：实现 kernel、SQLite 文档存储、WebSocket 同步和最小 Web 客户端。

### M1 报告
- 完成情况：✅ `packages/kernel` 提供 Principal / Role / 表驱动 `can()`、Result、Clock / IdGenerator、Yjs `DocumentHandle` 与 Anchor 创建/解析；✅ `apps/server` 提供 SQLite 文档存储、种子配置、文档查询和 WebSocket 更新同步；✅ 低于 editor 的连接会被服务端丢弃更新；✅ `apps/web` 提供身份切换、文档列表、只读角色保护、文本编辑和在线成员显示。
- 如何验证：`pnpm check`；`pnpm --filter @collab/web build`；以 `PORT=8789 COLLAB_DB_PATH=m1-test.db pnpm --filter @collab/server dev` 启动后，HTTP 查询返回种子文档；Dan 的 WebSocket 更新被丢弃，Bob 的更新被接受并可重新查询；本地两个浏览器页实测 Bob 编辑后 Dan 窗口同步更新，Dan 的 textarea 为只读。
- 偏离与决定：使用内置 `node:sqlite` 运行时完成 SQLite repository，原因见 `docs/decisions.md`；WebSocket 使用 JSON 包装 Yjs update，原因见同文件。
- 已知问题：Web 客户端是轻量 textarea 编辑器，尚未使用 CodeMirror 6 的完整绑定；远程光标目前传输选区状态并展示在线成员，未绘制光标装饰；评论、建议和 agent 尚未实现。
- 下一步建议：M2 实现统一 Thread / Message / Suggestion 领域模型、审批生命周期、REST / SSE 和侧栏。

### M2 报告
- 完成情况：✅ `packages/review` 提供 Thread / Message / Suggestion / Batch 领域模型、权限策略、锚点解析、审批状态机、重叠建议失效和批量处理；✅ SQLite repository 与文档库共用同一连接，接受建议时文档替换和建议状态在同一事务中提交；✅ server 提供评论、回复、解决线程、创建/接受/拒绝建议、批量处理和 SSE 事件；✅ 服务端解析 `@displayName` 提及并跳过重名；✅ web 提供评论/建议侧栏、角色控制、接受/拒绝操作和原文→新文的 diff 预览。
- 如何验证：`pnpm check`；`pnpm --filter @collab/web build`；启动独立端口后验证创建线程、`@Polisher` 解析、建议接受、空 JSON POST、SSE `thread.created` 事件；停止并重启服务后，已接受的替换仍从 SQLite 恢复。
- 偏离与决定：编辑器仍是轻量 textarea，diff 目前在建议卡片中预览，尚未接入 CodeMirror 的正文装饰；事件总线仍是单进程内存实现，重启后不提供历史事件回放。
- 已知问题：M3 agent dispatcher、运行记录和 agent 标签页尚未实现；批量处理 API 已提供，web 尚未展示 Batch 卡片。
- 下一步建议：实现 agent 运行协议、上下文裁剪、超时/重试和前端 Agent 运行记录。

### M3 报告
- 完成情况：✅ `packages/agent` 提供 mock、openai-compatible、CLI 适配器接口；selection/window/full 上下文构建；JSON 输出提取与 edit 定位校验；有效角色过滤；超时、一次重试、失败反馈、运行记录和 `(agentId, threadId)` 单飞调度；✅ server 接入默认 mock agent、SQLite `agent_runs` / `agent_views`、`agent.status` SSE、Agent 查询接口；✅ web 增加 Agent 标签页。
- 如何验证：`pnpm check`；`pnpm --filter @collab/web build`；真实服务冒烟验证 `@Polisher 把「A」改成「B」` 生成待审建议，Alice 接受后正文从 `A` 变为 `B`，运行记录写入，Agent 状态回到 idle；Dan 以 commenter 触发时只收到回复，不生成建议。
- 偏离与决定：agent 配置默认从文档成员生成并使用 mock；OpenAI-compatible 与 CLI 适配器已实现可替换接口，运行时通过配置选择，尚未在本机调用真实模型或命令行工具。
- 已知问题：Agent 标签页当前只读展示；任务线程的 agent 指派与完整的人工修改并发演示留到 M4；人工修改 diff 的提示已写入上下文，但还没有独立的可视化记录。
- 下一步建议：补任务型评论的 agent 指派、Batch 进度界面、重新生成和人工修改感知的并发演示。

### M4 当前进展
- 已完成：review 层的 Batch 创建/进度/逐条处理与 accept-remaining/reject-remaining API；agent 的 effectiveRole、selection/full 上下文、人工快照、重叠建议 stale；stale agent suggestion 的 regenerate API 与 web 操作入口。
- 已完成：任务线程可在创建时指定文档成员 agent，创建即触发一次运行；web 已显示 Batch 处理进度并提供「接受剩余 / 拒绝剩余」。
- 已完成：CodeMirror 6 编辑器已替换正文 textarea；Agent 标签页 owner 可保存/恢复文档级适配器、上下文策略和授予角色配置，配置持久化在 SQLite。
- 尚未完成：完整的人工修改并发演示；当前 CodeMirror 仍通过父层 Yjs 状态桥接，未使用专用 y-codemirror binding。

### M5 当前进展
- 已完成：README、API 速查和 `docs/demo.md` 已对应当前 server/web 启动方式、评论提及、mock agent、审批和 stale 演示流程。
- 尚未完成：独立的 `pnpm demo:seed` 重置脚本；当前首次启动 server 会按 `seed.config.json` 自动种子。

### M6 报告
- 完成情况：✅ `scripts/eval-contexts.mjs` 对任务集在 `selection`、`window`、`full` 三种策略下构建上下文，执行 JSON 输出提取、编辑定位、重试和建议计数，并输出 CSV；✅ `scripts/eval-concurrency.mjs` 使用可复现 PRNG 模拟多客户端编辑、评论、建议和最终同步，报告收敛、锚点 `exact` / `relocated` / `detached` 与过期建议检出比例；✅ 根 `package.json` 增加 `eval:contexts` 与 `eval:concurrency` 入口，并提供 `eval/taskset.json` 示例任务集。
- 如何验证：`pnpm eval:contexts eval/taskset.json`；`pnpm eval:concurrency --clients 4 --steps 200 --seed 42`；两条命令均在 Windows PowerShell 下直接输出结果，重复相同 seed 的并发事件序列保持一致。
- 偏离与决定：评测脚本保持纯 Node 实现，不引入运行中的服务或新的依赖；并发评测用 `--steps` 控制事件数，以便在本地和 CI 中复现，不等待真实秒数。上下文评测的 `latency` 是本机执行协议构建与校验的毫秒耗时，`rawOutputs` 仅用于任务集显式描述适配器输出和重试场景。
- 已知问题：脚本评估的是确定性 mock 协议和内存并发模型，不等同于真实模型网络延迟或多进程 Yjs 压测；需结合 `agent_runs` 和人工演示评估真实适配器。
- 下一步建议：将线上 AgentRun 导出为相同任务集格式后，补充真实适配器的离线结果对比。

### M7 当前进展：真实 Agent provider 接入
- 完成情况：✅ `/api/agent-providers` 探测本机 Codex CLI 与 Claude Code 的版本和登录状态；✅ owner 可创建 agent principal、文档成员关系与 provider 配置；✅ Codex/Claude 使用固定预置参数和 `shell:false` 子进程，OpenAI-compatible 支持 API key 会话注入；✅ `accessPolicy` 支持 public/private，private 只接受 agent owner 或文档 owner 的交互。
- 如何验证：`corepack pnpm check`；`corepack pnpm --filter @collab/web build`；临时端口上调用 provider 探测、创建 agent、CLI connect、OpenAI connect；检查 SQLite 确认 session key 未写入。
- 偏离与决定：Claude 的非交互状态通过当前 CLI 的 `claude auth status` JSON 判定；Codex 使用官方 `codex login status`；二者均不读取 credential 文件。OpenAI key 默认只存 server 进程内，重启后需要重新连接。
- 已知问题：真实 Codex/Claude 模型调用仍需用户本机 CLI 登录、模型额度和可用网络；Claude/Codex CLI 的版本行为可能变化，探测接口会如实返回 unknown 或命令错误。
- 完成情况：✅ 前端 Agent 配置面板已接入 provider 探测、创建 agent、CLI/API connect，并明确展示 session-only 状态。
- 追加验证：✅ Codex preset 已显式使用 `model_reasoning_effort=medium`；Node spawn 实测默认 `ultra` 超时、`medium` 约 15 秒返回。✅ 系统 prompt 明确 edit 协议为 `op` / `quote` / `newText`，禁止 `replacement`；相关运行结果可继续通过 `agent_runs` 检查。

### M8 当前进展：文档空间与编辑室工作台
- 完成情况：✅ 新增 workspace 文档空间模型，空间成员角色默认继承到空间内文档，文档级 membership 可以覆盖；✅ 支持创建多个纯文本文档、邀请已有身份并授予 viewer/commenter/suggester/editor 角色；✅ Agent 可由 commenter 以上操作者添加，授予角色不超过操作者，private Agent 对其他成员不可见且不能被 @；✅ 左侧工作区已接入空间切换、文档树、新建空间、新建文档、空间成员邀请和段落大纲；✅ 前端改为 editorial folio 视觉方向，CodeMirror、正文、评论、建议和 Agent 配置保留现有功能。
- 如何验证：`corepack pnpm check`；`corepack pnpm --filter @collab/web build`；临时端口手动验证空间创建、成员邀请、文档创建与继承权限；Impeccable detector 对已修改 UI 文件仅发现并已修复一个字体告警。
- 偏离与决定：第一代仍只支持 UTF-8 纯文本；大纲由空行分隔的段落首行生成，具体决定见 `docs/decisions.md`。
- 已知问题：文档大纲目前能选中对应段落范围，但还没有把 CodeMirror 视图滚动到该段落；空间成员的角色编辑/移除已提供 REST API，前端当前提供邀请入口，后续可补齐管理操作面板。
- 下一步建议：补充大纲滚动定位和空间成员角色编辑/移除界面，再根据真实多人使用反馈调整布局密度。

### M9 报告：本地项目模式
- 完成情况：✅ 空间增加 `managed` / `local` / `imported` 来源；✅ 服务端可绑定绝对目录并递归扫描 `.txt` 文件，按相对路径映射到空间文档；✅ 编辑更新通过临时文件和原子替换写回；✅ 保存文件哈希、大小、修改时间和 `synced` / `updated` / `conflict` / `missing` 状态；✅ 浏览器支持目录选择时保留当前页面文件句柄并写回，降级的 `webkitdirectory` 只做导入；✅ 前端提供选择文件夹、路径绑定、重新扫描、同步当前文档和状态提示。外部文件变化在重新扫描或同步时检测，当前不运行后台文件监听器。
- 如何验证：`corepack pnpm check`（8 个测试文件、36 个测试）；`corepack pnpm --filter @collab/web build`；`apps/server/test/local-project.test.ts` 覆盖递归扫描、扩展名过滤、原子写回、磁盘独改冲突、文件缺失和浏览器导入区分。
- 偏离与决定：浏览器无法把任意本地绝对路径交给服务端，因此服务端实时模式需要填写服务端可访问路径；浏览器 fallback 导入不承诺跨刷新持续写回。设计记录见 `docs/decisions.md`，接口说明见 `docs/local-project.md`。
- 已知问题：冲突只阻止覆盖并显示状态，尚未提供“保留编辑器内容 / 重新载入磁盘内容”的二选一操作；多人客户端共享服务端目录绑定，浏览器导入模式只影响当前导入页面。
- 下一步建议：补充冲突解决动作和导入文件的重新导出入口，再进行真实多客户端文件变化演示。

### M10 报告：编辑器式项目信息架构
- 完成情况：✅ 项目空间只保留项目切换、新建和项目设置入口；✅ 左侧改为按相对路径渲染的可折叠文件树；✅ 文档大纲作为文件树下的次级导航；✅ 本地目录绑定、扫描和写回收进项目设置，默认不占用文件导航区域；✅ 项目成员文案和编辑器区域保持独立。
- 如何验证：`corepack pnpm check`（8 个测试文件、36 个测试）；`corepack pnpm --filter @collab/web build`；浏览器检查项目切换、嵌套文件树、设置展开/收起和编辑器主区域。
- 偏离与决定：保留后端 `workspace` API 和数据模型，前端将其呈现为项目空间，避免迁移已有协作数据；目录与同步功能继续沿用原有权限和接口。
- 已知问题：窄屏下仍会按现有响应式规则收起成员区，文件树和编辑器的完整移动端交互不在本代范围内。
- 下一步建议：补充文件树的拖拽排序或重命名之前，先用真实项目目录验证目录层级和文档切换频率。

### M11 报告：分层创建与项目设置交互
- 完成情况：✅ 新建项目、新建文档和邀请成员改为居中 Modal；✅ 项目设置与目录同步改为右侧 Drawer；✅ 侧栏只保留入口，表单从文件导航节奏中移出；✅ 弹层支持遮罩关闭、关闭按钮、Esc、Tab 循环、打开后聚焦和关闭后回焦；✅ 打开弹层时锁定底层滚动，并保留移动端宽度适配。
- 如何验证：`corepack pnpm check`（8 个测试文件、36 个测试）；`corepack pnpm --filter @collab/web build`；浏览器逐一打开四类弹层，验证表单内容、Esc、焦点回退和设置抽屉。
- 偏离与决定：采用 WAI-ARIA APG 的 dialog 语义和键盘行为，不新增 UI 依赖；创建操作用居中确认层，项目设置用侧边抽屉以保持编辑器上下文。
- 已知问题：弹层目前是前端复用组件，尚未抽取到独立 UI 包；文件树拖拽排序和成员权限编辑仍不在本里程碑。
- 下一步建议：先收集真实使用反馈，再决定是否需要把评论线程、Agent 配置也改成独立抽屉或保留右栏常驻。

### M12 报告：项目来源与打开流程
- 完成情况：✅ 新建项目明确区分“本地文件夹”和“空项目”；✅ 本地来源在创建后立即扫描/导入 TXT，填写服务端绝对路径时可持续扫描并写回；✅ 空项目明确保存在本地 SQLite，不自动创建文件夹；✅ 已有项目入口改为“打开文件夹”或“目录与同步”，抽屉只处理文件来源、扫描状态和写回操作。
- 如何验证：`corepack pnpm check`；`corepack pnpm --filter @collab/web build`；浏览器打开“新建项目”检查两种来源说明，切换到空项目检查 SQLite 说明，打开已有项目的“目录与同步”检查来源和扫描操作。
- 偏离与决定：项目仍复用现有 workspace API 和本地 SQLite；浏览器选择的文件夹不能提供服务端绝对路径，因此只承诺当前页面导入/写回，持续扫描需要填写服务端可访问路径。决定见 `docs/decisions.md`。
- 已知问题：浏览器降级的 `webkitdirectory` 导入无法跨刷新保留文件句柄；冲突文件仍需在后续版本增加保留编辑器内容/重新载入磁盘内容的操作。
- 下一步建议：先让用户验证“新建项目 → 选择来源 → 创建并打开”和“已有项目 → 目录与同步”两条路径，再决定是否增加最近打开项目或导入后的导出入口。

### M13 报告：成员注册与空间邀请
- 完成情况：✅ 增加本地 demo 人类身份注册接口；✅ owner 可创建空间待处理邀请，邀请对象接受后才加入 workspace membership；✅ 当前身份可查询、接受或拒绝邀请；✅ owner 可在成员弹窗中修改角色或移除成员；✅ 保留原有直接成员接口以兼容已有 demo 数据。
- 如何验证：`corepack pnpm check`（9 个测试文件、39 个测试）；`corepack pnpm --filter @collab/web build`；浏览器实际走通“注册本地身份 → 发送邀请 → 切换身份 → 接受邀请 → owner 修改角色”，`apps/server/test/invitations.test.ts` 覆盖待处理、越权响应、重复邀请更新和接受后角色继承。
- 偏离与决定：不引入认证、邮箱或 token；注册仅创建本地 human principal，邀请按 principal id 定向，决定见 `docs/decisions.md`，接口见 `docs/api.md`。
- 已知问题：邀请通知目前需要被邀请者主动刷新列表；当前 demo 身份没有密码或外部账号认证。
- 下一步建议：补充 owner 的邀请撤回操作，并在需要真实账号体系时另立认证设计。

### M14 报告：本地 demo 账户管理
- 完成情况：✅ 增加当前账户查询与显示名更新；✅ 增加账号切换校验接口，明确由前端替换 `x-principal-id`；✅ 增加无状态登出确认接口，前端清除当前身份；✅ 顶栏改为个人账户菜单，账户菜单只列人类账号并提供资料编辑、创建账户、切换和退出；✅ 项目切换改为应用内菜单；✅ 项目成员区只保留一个“管理成员”入口；✅ 不引入密码、邮箱、token 或认证会话。
- 如何验证：`corepack pnpm check`（10 个测试文件、40 个测试）；`corepack pnpm --filter @collab/web build`；浏览器验证个人账户菜单、项目空间菜单、资料编辑弹窗和账号切换；接口契约同步到 `docs/api.md`。
- 偏离与决定：这是 demo 身份管理，不是注册认证系统；决定见 `docs/decisions.md`。
- 已知问题：登出和切换只影响当前浏览器的身份选择，服务端不维护登录态；后续若需要真实账户体系必须另立认证设计。
- 下一步建议：如果需要跨设备登录，再单独设计认证、会话和账号恢复流程。

### M15 报告：成员与 Agent 配置层级调整
- 完成情况：✅ Agent 配置从右侧独立 tab 移入项目成员操作；✅ 每个 Agent 成员提供单独“配置”入口，新增 Agent 也从成员区进入；✅ 右侧协作面板只保留评论和建议；✅ 顶栏账户入口改为右上角圆形头像，账户菜单仍保留切换、资料编辑、创建和退出；✅ 项目选择器和成员标题调整了层级与间距。
- 如何验证：`corepack pnpm check`（10 个测试文件、40 个测试）；`corepack pnpm --filter @collab/web build`；浏览器打开 Agent 配置抽屉，确认连接方式、权限和上下文可编辑；确认账户头像菜单和评论/建议面板可用。
- 偏离与决定：成员配置采用右侧 drawer 保留正文上下文，具体决定见 `docs/decisions.md`；本里程碑只调整前端信息架构，不改变 Agent API 或权限规则。
- 已知问题：成员邀请弹窗内的角色选择仍使用原生 select；账户仍是本地 demo 身份，不提供跨设备认证。
- 下一步建议：统一成员邀请和 Agent 配置中的选择控件视觉样式，再根据真实使用反馈调整抽屉宽度与移动端布局。

### M16 报告：数据库账户标识与分离式邀请流程
- 完成情况：✅ principals 增加持久化的唯一 `handle`，并支持未验证的 `email` 作为第二种账号标识，启动时为既有人类账户回填可查找 handle；✅ 新增 `/api/accounts/search?q=`，只返回数据库中的人类账户；✅ 邀请接口推荐使用 `{ identifier, role }`，服务端按 handle 或 email 解析目标，保留旧 `principalId` 兼容；✅ 待处理邀请、接受/拒绝和当前成员接口继续独立工作；✅ 账户注册与资料更新支持 handle/email；✅ 认证、密码、邮箱验证和跨设备会话仍未实现。
- 如何验证：`corepack pnpm check`；`apps/server/test/invitations.test.ts` 覆盖大小写无关的账号查找与 Agent 排除；`apps/server/test/account.test.ts` 覆盖 handle 持久化、更新和唯一性检查。
- 偏离与决定：当前仍使用本地 SQLite 作为数据库-backed demo，不伪装接入外部云数据库；账号 handle 只是可查找标识，不是登录凭据。决定见 `docs/decisions.md`，接口见 `docs/api.md`。
- 已知问题：搜索目录和邀请仍依赖 `x-principal-id` demo 身份；真正的注册、登录、通知和跨设备会话需要后续独立认证设计。
- 下一步建议：前端把成员弹窗拆成“发送邀请 / 待处理邀请 / 当前成员”三个区域，发送邀请只提交账号标识与角色，不再渲染全量成员下拉框。

### M17 报告：数据库账户邀请界面
- 完成情况：✅ 当前成员、发送邀请、待处理邀请拆成三个独立视图；✅ 发送邀请按账号标识或显示名称搜索数据库账户，不再从当前成员下拉框选择；✅ 发送后只创建 pending invitation，接受后才写入空间成员；✅ 当前成员视图保留权限调整、移除成员和 Agent 配置入口；✅ 支持输入带 `@` 的账号标识，搜索和提交规则保持一致。
- 如何验证：`corepack pnpm check`；`corepack pnpm --filter @collab/web build`；浏览器实际验证“搜索数据库账户 → 发送邀请”，接口验证邀请进入 pending，随后接受后成为 workspace membership。
- 偏离与决定：成员目录和邀请记录写入现有 SQLite 数据库；当前浏览器身份仍通过 `x-principal-id` 传输，认证会话未在本里程碑伪装实现，决定见 `docs/decisions.md`。
- 已知问题：账户菜单仍保留 demo 身份切换入口，便于本地测试多账户邀请；真正登录、会话、通知和跨设备访问仍需独立认证设计。
- 下一步建议：先由用户验证三段式成员流程和数据库账户搜索，再决定是否进入真实登录与会话层。

### M18 报告：真实账户、登录会话与数据库邀请
- 完成情况：✅ 人类账户注册写入 SQLite，保存唯一 handle、可选 email 和 scrypt 密码哈希；✅ 登录支持 handle 或 email，服务端创建 HttpOnly、SameSite 会话 cookie，并提供会话恢复与退出；✅ 工作区、文档、评论、Agent 配置、SSE 和 WebSocket 均从 cookie 会话识别当前用户；✅ 前端移除身份下拉切换和本地身份创建入口，未登录时先进入注册/登录页；✅ 成员邀请继续按数据库账号标识发送，接受后才写入空间成员；✅ 旧 `x-principal-id`、查询参数身份和本地切换接口默认关闭，仅显式开发兼容模式可用；✅ 无密码的旧 seed 账户可按既有 handle 认领，保留原演示空间成员关系。
- 如何验证：`corepack pnpm check`（12 个测试文件、47 个测试）；`corepack pnpm --filter @collab/web build`；HTTP 冒烟验证注册 → cookie 会话 → 退出，错误密码和旧身份 header 均被拒绝；前端 SSE/WebSocket URL 不再携带 principal 参数。
- 偏离与决定：当前数据库仍是服务端进程使用的本地 SQLite 文件，密码重置、邮箱验证和云端部署不在本里程碑范围；具体认证取舍记录在 `docs/decisions.md`，接口见 `docs/api.md`。
- 已知问题：旧 `collab.db` 中没有密码的 seed 账户需要先用注册表单认领一次；新账号需要通过真实 handle 或 email 接收邀请，未加入空间前不会看到空间内容。
- 下一步建议：先用两个真实账号在浏览器验证“注册/登录 → 邀请 → 接受 → 协作”，再决定是否增加密码找回和邮件通知。

### M19 报告：本地文件夹选择兼容性修复
- 完成情况：✅ 空项目状态移除重复的“打开文件夹”入口；✅ 已有项目统一从“项目设置 / 目录与同步”绑定目录；✅ 新建项目和已有项目都使用原生 `label` 关联 `webkitdirectory` 文件输入，支持 File System Access API 时仍优先保留目录权限与写回能力；✅ 文件输入不再使用 `hidden` 属性，避免部分 Chromium 内嵌环境忽略脚本触发的文件选择器。
- 如何验证：`corepack pnpm check`（12 个测试文件、47 个测试）；`corepack pnpm --filter @collab/web build`；`git diff --check`；浏览器 DOM 检查确认文件输入为 `hidden=false`、包含 `webkitdirectory`，选择标签与 input 的 `htmlFor/id` 已关联。
- 偏离与决定：Codex 内嵌浏览器不暴露操作系统文件选择窗口，无法在该环境中替用户完成最后一步目录选择；实际 Chrome/Edge 由原生文件控件处理，仍可使用“服务端路径”作为无文件选择器环境的后备路径。具体决定见 `docs/decisions.md`。
- 已知问题：浏览器导入模式只能在当前页面保留文件句柄；若浏览器不提供目录权限 API，持续扫描和跨刷新写回仍需填写服务端可访问路径。
- 下一步建议：在用户实际使用的 Chrome/Edge 中点击“新建项目 → 本地文件夹 → 选择项目文件夹”验证目录授权，并确认 TXT 文件出现在左侧文件树。

### M20 报告：Chrome 文件夹选择控件直连
- 完成情况：✅ 新建项目和目录设置的真实 `input[type=file]` 直接覆盖在选择按钮区域，避免 Chrome 忽略 `label` 或脚本间接触发；✅ 支持目录权限 API 时仍从 input 的用户点击事件进入目录句柄流程；✅ 仍保留 `webkitdirectory` 和 TXT / Markdown 过滤；✅ 切换到浏览器导入模式时清空旧目录句柄，避免后续写回旧文件。
- 如何验证：`corepack pnpm check`（12 个测试文件、47 个测试）；`corepack pnpm --filter @collab/web build`；Impeccable detector 返回空结果。Chrome 原生文件窗口无法由当前自动化连接代替用户选择，但页面控件已改为直接接收原生 input 点击。
- 偏离与决定：文件选择窗口属于浏览器外部原生 UI，自动化环境无法安全替用户完成最终目录选择；用户在桌面 Chrome 中点击按钮后应由真实 input 打开目录选择窗口。
- 已知问题：Codex 内嵌浏览器仍可能不提供原生文件窗口；该环境请使用“服务端路径”字段，桌面 Chrome/Edge 使用“选择项目文件夹”。

### M21 报告：TXT / Markdown 本地项目映射
- 完成情况：✅ 服务端目录扫描、浏览器文件夹导入、重新扫描、冲突检测和原子写回均支持 `.txt` / `.md`，扩展名大小写不敏感；✅ 映射继续以 `workspaceId + relativePath` 为稳定身份，保留原始扩展名；✅ 前端文件选择、过滤、状态提示和新建文档占位符同步支持 TXT / Markdown；✅ `.markdown`、图片等其他扩展名继续跳过或拒绝。
- 如何验证：`corepack pnpm check`（12 个测试文件、47 个测试）；`corepack pnpm --filter @collab/web build`；`apps/server/test/local-project.test.ts` 覆盖嵌套 `.TXT` / `.MD` 扫描、导入和扩展名校验。
- 偏离与决定：`.md` 当前按 UTF-8 纯文本编辑和写回，不把 Markdown 标题拆成多个空间文档，也不引入 Markdown 渲染；具体映射决定见 `docs/decisions.md`，接口说明见 `docs/local-project.md`。
- 已知问题：Markdown 预览、语法高亮和渲染安全策略仍未实现；如果需要，将作为独立的编辑器功能设计，不改变文件映射关系。

### M22 报告：Markdown 源码与预览切换
- 完成情况：✅ `.md` 文档在现有 CodeMirror 编辑器中增加“源码 / 预览”切换；✅ 源码模式继续使用同一份 Yjs 文本状态，协作编辑、评论选区和本地写回路径不变；✅ 预览只读展示标题、段落、列表、引用、代码块、分隔线和常见行内格式；✅ `.txt` 仍保持纯源码编辑，不显示预览切换。
- 如何验证：`corepack pnpm check`（12 个测试文件、48 个测试）；`corepack pnpm --filter @collab/web build`；检查 `CodeMirrorEditor` 与 Markdown 预览组件的 TypeScript、ESLint 和构建结果。
- 偏离与决定：预览使用无 `dangerouslySetInnerHTML` 的小型 React 渲染器；原始 HTML 不执行，图片只显示替代文字，链接只允许 `http`、`https` 和 `mailto`，避免本地 Markdown 内容触发任意 HTML 或网络资源加载。
- 已知问题：暂不支持表格、任务列表、脚注、数学公式和图片加载；这些属于预览表现层，不影响源码协作和写回。
- 下一步建议：如果真实文档需要完整 CommonMark/GFM，再单独评估成熟解析器和安全策略，不改变当前一文件一文档映射。

### M23 报告：项目顶部导航与基础管理
- 完成情况：✅ 顶部导航提供当前可见项目切换和新建入口；✅ 项目侧栏只保留当前项目上下文、文件目录和成员，不再把项目切换菜单堆在文件导航上；✅ owner 可重命名项目；✅ owner 删除项目时必须精确输入项目名称确认，服务端事务清理项目关联数据；✅ 删除后自动切换到剩余项目或空状态。
- 如何验证：`corepack pnpm check`（12 个测试文件、48 个测试）；`apps/server/test/auth-routes.test.ts` 覆盖重命名、错误确认和删除后资源不可见；`corepack pnpm --filter @collab/web build`。
- 偏离与决定：项目切换只显示当前账户可见的项目；重命名和删除通过项目设置执行，删除不触碰本地磁盘目录，只删除数据库映射和协作数据。详见 `docs/decisions.md`。
- 已知问题：删除是不可逆数据库操作，当前没有回收站；本地源文件不会被删除，仍需用户自行管理。
- 下一步建议：先验证顶部切换、项目重命名和删除确认的使用路径，再决定是否增加最近项目或回收站。

### M24 报告：项目设置抽屉层级修复
- 完成情况：✅ 将当前项目名称、重命名/删除操作与目录同步拆成两个独立区块；✅ 目录同步卡恢复专用内边距，标题、状态和操作按钮不再贴边；✅ 为项目标签补齐统一的文字层级和间距。
- 如何验证：Chrome 打开“项目设置”抽屉，确认项目标题只出现一次，目录与同步单独位于下方卡片；`corepack pnpm check`；`corepack pnpm --filter @collab/web build`。
- 偏离与决定：本里程碑只修复项目设置的信息层级和样式覆盖，不改变项目、目录扫描或写回逻辑。
- 已知问题：生产构建仍提示主 bundle 超过 500 kB，这是已有构建提示，与本次布局修复无关。
- 下一步建议：让用户在实际 Chrome 中继续验证项目设置、文件夹选择和项目管理流程。

### M25 报告：创建时绑定本地项目与项目级同步
- 完成情况：✅ 新建项目流程移除“空项目”来源选择，创建前必须选择本地文件夹或填写服务端目录路径；✅ 项目创建成功后立即扫描并建立本地文档映射；✅ 项目设置移除目录选择、路径填写和单文档写回操作，只显示本地连接状态；✅ 当前项目侧栏增加“同步”按钮，服务端目录使用扫描协调云端与本地内容，浏览器目录使用当前页面保留的目录句柄重新导入并写回。
- 如何验证：Chrome 打开“新建项目”检查本地文件夹和服务端路径字段；打开已有项目确认项目设置不再出现“目录与同步”管理卡；绑定本地项目后从侧栏点击“同步”；`corepack pnpm check`；`corepack pnpm --filter @collab/web build`。
- 偏离与决定：本地目录连接在项目创建时建立；浏览器安全模型不允许跨刷新保存目录句柄，刷新后若项目使用浏览器导入模式只能继续使用已导入副本，服务端目录模式可持续同步。决定见 `docs/decisions.md`。
- 已知问题：浏览器导入模式的目录句柄只在当前页面会话有效；服务端路径模式仍要求服务端进程能访问该目录。
- 下一步建议：用户在 Chrome 中用一个包含 TXT / Markdown 的本地目录创建测试项目，再验证本地文件修改、编辑器修改和“同步”按钮的双向结果。

### M26 报告：本机多账号登录与账户切换
- 完成情况：✅ 登录或注册成功后自动保存当前账号标识、密码和显示信息到当前浏览器的本机账户列表；✅ 登录页展示已保存账号，可直接登录并逐条删除；✅ 右上角圆形账户菜单展示本机账号，可直接切换会话，并提供清除本机保存记录和退出当前账号；✅ 服务端新增 `/api/auth/switch`，验证凭据后只替换当前浏览器的 HttpOnly 会话，不撤销其他设备会话；✅ 侧栏文件、大纲、成员区块统一收紧标题与说明间距。
- 如何验证：`corepack pnpm check`（12 个测试文件、49 个测试）；`corepack pnpm --filter @collab/web build`；Chrome 检查登录页本机账号列表和右上角账户菜单。
- 偏离与决定：设备账户列表只存在于浏览器 `localStorage`，不是服务端账号目录；密码仍由服务端使用 scrypt 哈希保存，浏览器端保存明文凭据只为实现本机一键登录，界面提示共享电脑使用前清除记录。详见 `docs/decisions.md`。
- 已知问题：清除浏览器站点数据会删除本机快捷登录记录；本机保存记录不会跨浏览器或设备同步。
- 下一步建议：如需多设备账户同步，应另行设计受保护的凭据管理或短期设备授权流程，不直接把本机密码上传到云端。

### M27 报告：产品验收与发布前回归
- 完成情况：✅ 用隔离 SQLite 数据库和真实 HTTP 接口跑通“注册账号 → 新建空间/文档 → 选区任务 → @Polisher → Agent 回复 → 待审批建议 → owner 接受 → 正文更新”；✅ 明确替换请求生成的建议能以 `exact` 锚点写回正文；✅ Agent 上下文评测 9/9 条有效，非法 JSON 每种策略按预期重试一次；✅ 4 客户端并发评测收敛；✅ Chrome 实测评论、任务、人工建议接受/拒绝、TXT/Markdown 源码/预览、本地目录扫描写回、账号邀请与切换均可用；✅ MockAdapter 不再回显选区和完整上下文，只回复最新触发消息；✅ Agent edit 不在允许选区时，线程明确提示“未生成可审批修改建议”；✅ 同步结果现在列出更新、冲突和本地缺失；✅ 在线成员按实际 WebSocket 连接统计；✅ 正文变化后大纲自动刷新；✅ 建议角标显示待审批数量并保留历史总数；✅ 最近打开项目按账号在本机恢复。
- 如何验证：`corepack pnpm qa:product`（隔离服务，精确替换链路通过；自然语言扩展按 SPEC 产生 0 条 Mock 建议）；`corepack pnpm eval:contexts eval/taskset.json --out eval/results-20261017.csv`（9/9 valid）；`corepack pnpm eval:concurrency --clients 4 --steps 500 --seed 20261017 --out eval/concurrency-20261017.json`（converged true）；`corepack pnpm check`（12 个测试文件、51 个测试）；`corepack pnpm --filter @collab/web build`；Chrome 手动验收。
- 偏离与决定：MockAdapter 只支持 SPEC 规定的明确替换格式；“请扩展/润色”要产生真正的 edits，需要连接 Codex/Claude CLI 或 OpenAI-compatible provider。真实 CLI 任务可能需要数十秒，发布前应在界面保留“处理中”状态，不能把中间状态当成最终结果。决定见 `docs/decisions.md`。
- 已知问题：当前演示数据库中保留了本次浏览器验收产生的评论、任务、建议、文本改动和本地验收项目；发布 GitHub 前需要备份后清理或重置。CLI 自然语言任务的提示词和选区引用仍需用真实 CLI 再回归一轮；成员邀请不存在账号/重复账号的前端即时提示、手动 `@` 的交互引导和建议历史数量与待审批数量的区分仍可继续改善。
- 下一步建议：先清理演示数据并重启服务做一次干净 smoke，再发布 GitHub；发布说明中明确 Mock 的替换格式和真实 Agent provider 配置方法。


### M28 报告
- 完成情况：✅ 新增官方 Sign in with ChatGPT OSS OAuth 服务，支持动态注册、PKCE/state/nonce、loopback callback、issued client ID 复用、ID token JWKS 校验、ChatGPT plan scope 检查、refresh token 轮换和本机凭据文件；✅ Agent 的 Responses API adapter 支持从 OAuth profile 按运行时刷新 access token；✅ connect API 改为传 profileId，不接收 access token。
- 如何验证：`corepack pnpm typecheck`；`corepack pnpm exec vitest run apps/server/test/chatgpt-oauth.test.ts`（4 tests）；测试覆盖动态注册、scope 检查、issued client 复用、refresh token 轮换。
- 偏离与决定：OAuth 凭据不写 SQLite；agent_configs 只保存 profileId、ownerPrincipalId、模型与 endpoint；无 plan scope 时保留账号身份但阻止推理。
- 已知问题：真实 ChatGPT OAuth 需要用户在浏览器完成授权；当前工作区尚未进行真实账户登录和 Responses 请求，不能声称已消耗 Pro 额度。前端需要调用 `/api/auth/chatgpt/start` 并轮询 `/api/auth/chatgpt/attempts/:attemptId`。
- 下一步建议：前端加入 Continue with ChatGPT、profile 选择和 plan scope 状态；用真实授权 profile 进行一次自然语言扩展验收。

### M29 报告：官方 ChatGPT 计划授权与 Agent 接入
- 完成情况：✅ 增加账号级 Sign in with ChatGPT OSS OAuth，包含动态 client、PKCE、state/nonce、loopback callback、issued client ID 复用、JWKS ID token 校验、scope 检查、refresh token 轮换和 revoke；✅ Agent 连接只提交已授权 profileId，服务端按当前账户 profile 取 token，token 不经过前端、不写 SQLite、不返回 API；✅ Responses adapter 使用 `instructions`、`input`、JSON 输出格式，并发送 `store:false` / `stream:true`，解析流式输出和额度失败事件；✅ 前端显示授权账号、范围和状态，授权完成后可将 ChatGPT 计划绑定到 Agent。
- 如何验证：`corepack pnpm check`（13 个测试文件、56 个测试）；`corepack pnpm --filter @collab/web build`；`apps/server/test/chatgpt-oauth.test.ts` 覆盖动态注册、ID token 校验、scope 阻止、issued client 复用和 refresh token 轮换；`packages/agent/test/agent.test.ts` 覆盖 Responses 请求体、OAuth token 传递和响应 envelope。
- 偏离与决定：本地开源客户端使用官方动态注册路径；真实账户授权和额度消耗需要用户在浏览器明确同意，本地测试不伪造成功授权。默认模型 `gpt-6.1-sol` 只是初始值，应以授权账号实际模型目录为准。
- 已知问题：当前尚未用真实 ChatGPT profile 执行一次自然语言扩展；需要在本机完成授权并选择可用模型后再做最终在线回归。OAuth 本机凭据文件由用户自行保护，服务端不会把它同步到 GitHub。
- 下一步建议：完成一次真实授权与 Responses 请求验收，再清理验收数据库和临时目录，最后进行 GitHub 发布前的范围检查。

### M30 报告：统一模型提供商目录与 Agent 绑定
- 完成情况：✅ 新增统一提供商目录，整合 ChatGPT OAuth、Codex CLI、Claude Code、OpenRouter、DeepSeek 和自定义 OpenAI-compatible 接口；✅ 提供商状态统一返回 `connected` / `not-connected` / `unavailable` / `error`，授权未完成时仍保留卡片；✅ API key 连接只保留在当前 server 进程，不写 SQLite、不回传响应；✅ 新增 Agent 绑定已连接提供商的接口，避免 Agent 配置表单重复要求 key；✅ 增加提供商路由与连接生命周期测试。
- 如何验证：`corepack pnpm --filter @collab/server exec tsc -b --pretty false`；`corepack pnpm exec eslint apps/server/src/model-providers.ts apps/server/src/main.ts packages/protocol/src/index.ts apps/server/test/model-providers.test.ts`；`corepack pnpm exec vitest run apps/server/test/model-providers.test.ts`（3 tests）。
- 偏离与决定：当前 API-key 凭据仍是进程内会话连接，服务重启后需重新连接；统一目录只列出已有适配器可实际调用的提供商，其他协议需先实现专用 adapter。详见 `docs/decisions.md`。
- 已知问题：模型目录对 OpenRouter/DeepSeek 当前返回连接时选择的默认模型，尚未主动调用各供应商 `/models`；ChatGPT 模型目录依赖已完成 OAuth 授权。
- 下一步建议：前端提供商设置页直接消费 `/api/model-providers`，Agent 配置使用 `/bind-provider` 选择已连接提供商和模型。

### M31 报告：提供商设置与 Agent 绑定界面
- 完成情况：✅ 顶部“模型”入口打开独立提供商抽屉；✅ 已连接和未连接状态分组展示 OpenAI / ChatGPT、Codex CLI、Claude Code、OpenRouter、DeepSeek 和自定义兼容接口；✅ OAuth 未完成时仍保留 OpenAI 卡片和“未连接”状态；✅ API key 连接表单只提交到当前 server 进程，不再混入 Agent 表单；✅ Agent 配置改为选择已连接的提供商和模型，并通过统一绑定接口切换当前 Agent；✅ 保留权限、上下文和模型字段的保存入口。
- 如何验证：Chrome 打开顶部“模型”，确认提供商目录、连接状态和 OpenRouter 连接表单；打开成员中的 Agent 配置，确认已连接 CLI 可选择且当前绑定有明显反馈；`corepack pnpm check`（14 个测试文件、60 个测试）；`corepack pnpm --filter @collab/web build`；Impeccable detector 仅发现 Markdown 引用块已有的 3px 左边框，已收窄为 1px。
- 偏离与决定：提供商设置作为账户级全局入口，不再把 ChatGPT OAuth 嵌在 Agent 卡片顶部；Agent 只绑定已连接提供商，API key 仍按 M30 的进程内边界处理。界面沿用现有 editorial folio 视觉系统，不引入独立主题。
- 已知问题：实际 ChatGPT 授权仍需要用户在官方页面完成同意；新建 Agent 表单仍保留兼容旧接口的直接连接字段，后续可收敛为“先建成员、再从提供商目录绑定”。
- 下一步建议：在真实 ChatGPT profile 或 API key 连接后，选择一个 Agent 切换模型并跑一次真实自然语言任务，确认运行记录和建议结果符合预期。

### M32 报告：ChatGPT OAuth 失败可诊断性
- 完成情况：✅ OAuth token exchange 失败时服务端读取并记录 OpenAI 返回的有限错误正文；✅ 请求补充 `Accept: application/json`；✅ 授权失败回跳后前端显示可操作的错误提示并清理 URL 状态；✅ 对 `unsupported_country_region_territory` 做稳定错误分类，不把 OpenAI 原始正文回传浏览器；✅ 核对当前本机凭据文件和实际回调日志，确认本项目 OAuth profile 尚未保存成功。
- 如何验证：`corepack pnpm exec vitest run apps/server/test/chatgpt-oauth.test.ts`（5 tests）；`corepack pnpm --filter @collab/web build`；使用 Node `--use-env-proxy` 重启服务后完成真实授权，回调返回 302，凭据文件包含 1 个 profile、access/refresh token 和 `chatgpt.tokens.use.direct` scope。
- 偏离与决定：Codex CLI 的随机端口 OAuth 回调不等于本项目的 ChatGPT provider 连接；本项目仍要求官方授权回调使用自身的 `127.0.0.1:8788/api/auth/chatgpt/callback`，不会读取 CLI 的 OAuth 凭据。
- 已知问题：若服务端未启用与浏览器一致的环境代理，直连兑换可能再次收到 OpenAI HTTP 403 `unsupported_country_region_territory`；代理是否可用仍取决于账号、出口 IP 和 OpenAI 的区域准入策略。

### M33 报告：真实 ChatGPT Agent 冒烟测试
- 完成情况：⚠️ 已将 `Polisher` 从 Codex CLI 切换到 ChatGPT OAuth profile，并通过真实 UI 任务触发 `openai-responses`；请求确实到达 OpenAI，但账号收到 `subscription_sharing_user_not_eligible`，没有生成 Agent 回复或建议，不能判定为通过。
- 如何验证：任务文本为“@Polisher 这是一次真实 GPT 连通性测试。请用一句话概括当前文档第一段的主题，不要修改文档。”；运行记录保存为失败，`outputValid=false`；使用同一 OAuth 凭据复现 Responses 请求得到 HTTP 403 和完整结构化错误；服务端已改为保留错误码和消息，并通过 typecheck/lint。
- 偏离与决定：OAuth “已连接”只代表授权凭据和 scope 有效，不代表 ChatGPT 计划已获得 subscription sharing 推理资格；不重复循环授权，不把该次失败伪装成成功。
- 已知问题：当前账号不能通过 ChatGPT 计划额度执行 Responses API。需要使用 OpenAI API key、已连接的 Codex CLI，或具备 subscription sharing 资格的账号/环境。
- 下一步建议：先用 Codex CLI 或 API key 完成 Agent 端到端验收；若继续验证 ChatGPT 计划，先确认账号在 OpenAI 的参与应用/计划共享准入范围内。
- 下一步建议：在官方授权页点击允许后再次观察 token exchange 日志，确认凭据文件写入并在提供商目录显示“已连接”。

### M34 报告：移除不可用的 ChatGPT 计划连接并校正提供商配置
- 完成情况：✅ 从模型提供商目录和 Agent 绑定入口移除 ChatGPT 计划授权；✅ 保留 Codex CLI、Claude Code、OpenRouter、DeepSeek、OpenAI API 和自定义 OpenAI-compatible；✅ DeepSeek 改为官方 `https://api.deepseek.com` 与 `deepseek-flash`，OpenRouter、OpenAI API 和自定义接口不再预填错误 GPT 模型；✅ 已知提供商的 Base URL 由服务端固定；✅ Agent 配置不再显示 ChatGPT 模型字段，旧配置会提示切换到可用连接。
- 如何验证：`corepack pnpm check`（14 个测试文件、62 个测试通过，含旧 provider 路由 404 回归）；`corepack pnpm --filter @collab/web build`；浏览器实际打开模型面板确认只显示 6 个保留提供商，并把 Vite 代理切到当前服务端 `8788`。
- 偏离与决定：ChatGPT OAuth/Responses 低层兼容代码暂留，避免旧本地配置读取失败；新目录、绑定 schema 和 UI 均不再暴露该入口。决定见 `docs/decisions.md`。
- 已知问题：本次未为新 API key 连接执行真实外部模型调用；实际调用仍需用户提供对应 API key，并且连接凭据只在当前 server 进程中保存。
- 下一步建议：用 DeepSeek 或 OpenAI API key 连接后，绑定一个 Agent，发送一条自然语言任务并检查 Agent run 与建议生命周期。

### M35 报告：统一 Riff 产品品牌并发布到 GitHub
- 完成情况：✅ 登录页、顶栏和浏览器标题统一使用 `Riff`；✅ 增加标语 `Make every draft better.`；✅ ChatGPT OAuth 的应用提示名同步为 `Riff`；✅ README 更新产品定位；✅ 推送到现有 GitHub 仓库。
- 如何验证：`corepack pnpm check`（14 个测试文件、62 个测试通过，边界检查通过）；`corepack pnpm --filter @collab/web build`；`git diff --check`；推送后核对本地与 `origin/master` 提交 SHA。
- 偏离与决定：技术仓库名继续使用 `collab-docs-agent`，避免破坏已发布链接；产品品牌与仓库技术名称分离。
- 已知问题：Riff 名称尚未进行商标、域名或应用商店的正式核验。
- 下一步建议：启动本地服务，在浏览器检查登录页、顶栏和浏览器标签上的 Riff 品牌显示。

### M36 报告：Markdown 分级大纲与协作选区交互
- 完成情况：✅ Markdown 大纲只提取 `#` 到 `######` 标题并返回级别和源码区间，侧栏按级别缩进且去掉 Markdown 标记；✅ TXT 大纲继续按空行分隔段落生成；✅ Markdown 预览中的真实文字选区可以映射回源码区间，并在选区附近显示“评论 / 建议修改”浮窗；✅ 评论输入框输入 `@` 后显示当前空间成员和 Agent，支持前缀筛选、上下键、Enter/Tab、Esc 和鼠标选择；✅ 新建 Agent 后刷新空间成员数据，成员列表和管理成员入口会立即显示新 Agent。
- 如何验证：`corepack pnpm check`（15 个测试文件、64 个测试通过，边界检查通过）；`corepack pnpm --filter @collab/web build`；Chrome 实测 Markdown 标题大纲、TXT 段落大纲、预览选区浮窗，以及输入 `@` 后用 `ArrowDown` + `Enter` 插入成员。
- 偏离与决定：Markdown 大纲只识别 ATX 标题，不把正文段落或列表提升为大纲项；预览选区沿用现有评论/建议 API 的源码偏移，浮窗动作只切换右侧协作面板，不直接提交内容。
- 已知问题：Markdown 预览仍是轻量渲染器，未覆盖完整 CommonMark 语法；服务端当前仍按单进程 SQLite 和本地会话运行。
- 下一步建议：继续用真实项目文件验证跨段落选区、协作者切换和 Agent 任务链路，再进行发布前回归。

### M37 报告：编辑器协作入口与 Markdown 结构化预览重构
- 完成情况：✅ 源码与 Markdown 预览共用正文旁的选区浮窗，评论和建议输入不再要求用户在另一侧重复操作；✅ 选区评论浮窗支持当前空间成员和 Agent 的 `@` 候选、筛选、上下键、Enter/Tab 和 Esc；✅ 右侧协作面板统一承载成员、评论和建议，左侧只保留文件和文档大纲；✅ 无选区时提供明确的“评论整篇文档 / 建议修改整篇”入口；✅ 建议支持提交前编辑和作者撤回，评论支持作者撤回；✅ Agent 输出增加 `relatedEdits`，选区外的术语、指代、链接等一致性修改以独立待审建议呈现，不扩大原选区权限；✅ Agent 长文上下文按选区、线程、人工修改、窗口/大纲、全文素材分层截断，避免丢失触发任务；✅ Markdown 预览补充表格对齐、任务列表、删除线、自动链接、Setext 标题和 `~~~` 代码围栏，并保留源码偏移映射；✅ 正文变化会自动关闭过期选区浮窗，避免旧锚点被重复提交。
- 如何验证：`corepack pnpm check`（15 个测试文件、72 个测试通过，含长文线程保留和相关建议校验）；`corepack pnpm --filter @collab/web build`；`git diff --check`；浏览器实测 Markdown 预览表格和标题、预览选区浮窗、选区评论 `@` 候选，以及源码/预览共同的评论入口。
- 偏离与决定：预览仍是无 HTML 注入的轻量 GFM 子集，原始 HTML 和图片不执行；未覆盖的完整 CommonMark/GFM 语法继续显示为纯文本，不能把当前实现描述成完整 Markdown 编辑器。相关架构决定已写入 `docs/decisions.md`。
- 已知问题：嵌套列表、脚注、数学公式、引用式链接和复杂 HTML 尚未进入解析层；它们需要独立的 AST/source-map 设计，不能用单个正则补丁解决。
- 下一步建议：在发布前用真实 `.md` 文档覆盖嵌套列表、引用式链接和代码块内选区，再决定是否引入成熟 Markdown tokenizer；不改变现有一文件一空间文档映射。


### M38 报告：统一 Markdown 编辑视图并收敛整篇操作入口
- 完成情况：✅ 评论面板的文档级操作只保留“评论整篇文档”；✅ “建议修改整篇”只在建议面板出现，避免同一动作在评论和建议两个入口重复；✅ 源码与预览共用正文宽度、内容起点、内边距、字号、行高和滚动容器，预览标题保留 Markdown 层级但改用编辑器同一字体体系。
- 如何验证：Chrome 手动检查评论面板按钮列表为 `评论整篇文档`，建议面板按钮列表为 `建议修改整篇`；`corepack pnpm check`；`corepack pnpm --filter @collab/web build`；`git diff --check`。
- 偏离与决定：预览仍按 Markdown 语义显示标题层级，但不再使用独立衬线字体或独立居中版心；评论和建议是不同业务动作，分别由对应面板承载。
- 已知问题：完整 CommonMark/GFM 仍需后续 AST/source-map 扩展，当前实现继续按 M37 记录的轻量子集工作。
- 下一步建议：发布前继续用真实 Markdown 文档做一次跨段落选区、表格和代码块的回归。
