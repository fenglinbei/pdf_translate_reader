# QA Agent 第一阶段：可阅读、可测试的执行内核

状态：代码已实现，独立 QA 服务已完成 [两轮本地真实运行](qa-local-runs-2026-09-23.md)；长上下文成功路径与生产部署尚未验收。
版本与发布按 [交付规范](versioning-and-delivery.md) 执行。
`0.1.1-alpha.1` 已修复全文读取的字段契约，实际文档读取与合成路由测试通过；
下一步的 [失败记录与回落边界方案](qa-execution-observability-plan.md) 已准备，尚未实施。

本阶段沿用现有手写执行器，学习重点是一次 Agent 运行如何调用模型、执行工具、累积证据与停止。
保持现有 JSON 控制协议、提示词、预算、引用编号策略和 HTTP/SSE 契约，不引入新的 Agent 框架。
Agent 检索结束后，答案生成、引用校验、消息落库仍由原 QA 路由层 `server/routes/qa.mjs` 负责。

## 先看清楚：不是每个问题都会进入这个循环

`server/routes/qa.mjs` 处理 `/api/qa/stream` 时，先调用 `server/qa/queryRouter.mjs` 做一次问题分类，再决定路径：

```mermaid
flowchart TD
    Q["提问 /api/qa/stream"] --> R["queryRouter.classifyQuestionType<br/>独立模型调用 temperature=0"]
    R -->|global| LC["handleLongContextAnswer<br/>全文长上下文"]
    LC -->|成功| LCEND[全文回答保存并返回；无检索式引用]
    LC -->|失败| FB["发出 kind=fallback 的 agent_step"] --> L
    R -->|"detail / follow_up"| L["执行循环<br/>runCurrentPaperReasoningRetrieval"]
    R -->|chitchat| L
    L --> D[基于证据回答与引用校验]
```

- `global`（总结全文、核心贡献、论证链）**不进入执行循环**：先走全文长上下文路径并直接返回，失败才回落到循环。
  因此提问"总结这篇论文"时看不到 `tool_call` 事件是预期行为，不是环境故障。
- `detail` / `follow_up` 进入循环，这是本阶段的学习对象。
- `chitchat` 也进入循环，由控制器返回 `direct_answer` 动作处理。路由器单独分出 `chitchat` 目前只用于日志与诊断，不是分支条件。
- 一次问答至少包含一次 `queryRouter` 模型调用，之后才是循环内的控制器调用；估算延迟和额度时要把这一次算进去。

## 建议阅读顺序

先读第 0 行确认自己在整条链路中的位置，再读第 1-5 行的执行内核。

| 顺序 | 文件 | 负责什么 | 主要边界 |
| --- | --- | --- | --- |
| 0 | `server/routes/qa.mjs` | 入口与出口：鉴权、线程/消息落库、问题分类分流、调用执行循环、答案生成与引用校验 | 检索不在这一层；长上下文路径也在这一层，循环只是其中一条分支 |
| 1 | `server/qa/agentRunner.mjs` | 组装已有模型、检索、数据库实现 | 原有导出保留，调用方无需迁移 |
| 2 | `server/qa/agent/loop.mjs` | 模型决策 → 工具 → 观察 → 下一轮 | 管理运行状态、预算、结束与错误 |
| 3 | `server/qa/agent/controller.mjs` | 构建模型消息、解析和归一化动作 | 接收注入的 `complete`，不直接访问供应商 |
| 4 | `server/qa/agent/tools.mjs` | 注册、分发当前论文工具 | 从可信上下文绑定用户和论文 |
| 5 | `server/qa/agent/events.mjs` | 写入步骤/工具记录、更新时间线、发布事件 | 持久化成功后输出原 SSE 事件结构 |

辅助模块：`policy.mjs` 放预算与已有策略，`context.mjs` 处理多轮上下文，
`evidence.mjs` 合并/去重/选择证据，`queryPlan.mjs` 提供纯查询规划。`errors.mjs` 保留原错误类型与已完成步骤。
`heuristicLoop.mjs` 保留原规则驱动执行路径，但**生产已不可达**：`server/routes/qa.mjs` 只调用推理路径，
引用它的只有 `tests/qa/agentRunner.test.mjs` 与离线示例，学习时可以最后再看或跳过。
这些执行模块不导入 Supabase、HTTP 服务或供应商客户端；生产依赖集中在组装入口。

```mermaid
sequenceDiagram
    participant S as routes/qa.mjs
    participant L as 执行循环
    participant M as 模型适配
    participant T as 工具注册表
    participant E as 事件记录
    S->>L: 问题、已授权用户/论文、上下文
    L->>E: 记录 plan
    loop 控制器预算内
        L->>M: 当前证据、工具历史、剩余约束
        M-->>L: JSON 动作
        L->>L: 归一化并验证白名单
        alt search_current_paper / open_chunk
            L->>T: 工具名与参数
            T->>E: 工具结果写入后发布
            T-->>L: 新证据 / 已打开证据
            L->>E: 记录 observation
        else finish_retrieval / direct_answer
            L->>L: 结束循环
        end
    end
    L-->>S: 证据、步骤、诊断信息
    S->>S: 原答案生成与引用校验
```

模型当前收到的是预算上限、历史和轮次；是否达到调用上限由循环代码判断，不依赖模型自觉遵守。

## 四个接口如何协作

**模型适配**：`createQaControllerAdapter({ complete })` 返回 `callController(input)`。
`complete({ messages, model, signal, temperature })` 返回 `{ content }`。
现有 `server/chatModels/client.mjs` 继续处理 provider 调用与请求参数；共享的翻译适配逻辑没有改动。
模型返回 JSON 动作，循环再次归一化并验证动作白名单。
这一版尚未切换到供应商原生 function calling，也没有引入通用工具 JSON Schema 校验框架。

**工具注册**：每次运行通过 `createCurrentPaperToolRegistry(...)` 绑定身份、论文、取消信号和检索实现。
`execute(name, input, context)` 只能分发已注册的 `search_current_paper` / `open_chunk`。
模型参数中的 `userId`、`userDocumentId` 或 `scope` 不会覆盖授权范围。
`open_chunk` 只打开这次运行已持有的证据，不按模型给出的任意数据库 ID 读取其他文档。
工具的 `effect: read` 指业务内容只读，执行过程仍会写入审计步骤。

**事件输出**：`createAgentEvents({ insertStep, insertToolCall, emit })` 统一管理持久化与发布。
`recordStep(state, eventName, input)` 写步骤，`recordToolCall(state, step, input)` 将工具结果关联到步骤。
前端继续接收 `agent_step`、`gap_check`、`tool_call`、`observation` 等已有事件。
发送的是行动摘要、输入和结果概要；不新增模型私有推理文本的展示或存储。
循环只发出这 4 个事件；整条 SSE 流还有 `meta`、`retrieval`、`thinking`、`delta`、`citation`、`verifier`、`usage`、`finish`、`done`、`error`，
由 `server/routes/qa.mjs` 直接发出，前端消费位置见 `src/qa/qaClient.ts`。
注意三个注入端口并不对称：`insertStep` / `insertToolCall` 是必需项，`emit` 是可选调用（`emit?.(...)`）。
落库是硬要求；`emit` 可以不提供，但已提供的回调若抛异常，事件层不会自行吞掉。
因此不能把可选回调理解为“发布失败一定不会中断运行”；具体失败语义取决于 SSE 写入端口与调用方处理。

**执行循环**：分别维护证据、已打开证据、工具历史与调用次数。
工具返回后，证据会合并、重新编号，再进入下一次模型调用；模型不能直接执行任意函数。
正常结束与抛出 `QaAgentRunnerError` 时，服务都能拿到当前步骤时间线。

## 不需要 API key 的学习示例

```bash
npm run demo:qa
npm run demo:qa -- direct-answer
npm run demo:qa -- carryover
npm run demo:qa -- budget
npm run demo:qa -- unknown-action
npm run demo:qa -- search-error
npm run demo:qa -- heuristic-empty
```

脚本只调用纯执行模块与内存模拟依赖，输出每条事件、工具输入、控制器调用次数与最终证据。
在 `loop.mjs` 的 `callController`、`tools.execute` 和 `events.recordStep` 设置断点，
可以逐步看到决策与执行的区别。固定时间只用于模拟轨迹，不影响线上代码。

建议先观察默认场景：搜索得到 `C1` → 打开 `C1` → 下一轮能看到完整文本 → 结束检索。
再观察 `budget`：模型继续要求检索，但执行器按上限停止。

## 验证与后续边界

拆分前以 `23ddc3b` 的原执行器生成了 7 组完整合成轨迹；拆分后逐项比较结果、持久化入参、
事件顺序、模型上下文和检索参数，全部一致。覆盖正常检索/打开/结束、直接回答、带入上轮证据、
预算耗尽、非法动作、检索失败、规则检索为空。均不调用真实模型或数据库。

这次比较现在可以复算：`npm run check:agent-equivalence` 会从 git 历史重建 `240a8fe^`（即 `23ddc3b`）
的整棵树，把同一套场景同时喂给新旧两个实现，逐字段比较上述五个方面，不一致就报出具体字段并以非零码退出。
它依赖完整 git 历史，因此**不在 `npm run ci` 里**（CI 默认浅克隆）。基线提交可由 `--baseline=<rev>` 覆盖；
基线必须改到重构后的提交，才能把它当作"此后不许漂移"的快照，而不是"与重构前一致"的证明。

持续回归在 `tests/qa/agentRunner.test.mjs` 和 `tests/qa/agentRuntime.test.mjs`；
`tests/runtime/` 验证 QA 关闭时其他接口的可用性、独立服务路由，以及发布失败后的 QA 回滚。
CI 还运行文库、翻译、MathPix、模型等全项目测试。
注意提交的测试只断言"当前行为应该是什么"，无法发现契约被静默改变——那正是上面这个对照脚本的职责。

后续阶段再引入可恢复运行状态、取消/超时的统一终止语义、工具参数 schema、真实问答评测。
当前保留的 `maxSteps` 是记录上限；实际执行次数由 controller/search/open 的预算限制，
还不是统一的硬终止状态机。现有步骤落库也不等于断点恢复或进程崩溃后恰好执行一次。

新增工具时需要一起修改工具声明/处理器、模型动作协议、循环预算与观察处理、失败契约测试。
在这套边界稳定后，再判断是否需要动态调度或框架，避免仅为增加工具名称而提前泛化。
