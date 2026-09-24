# QA 配套方案 F02：失败记录与回落边界

状态：**实现方案与验证范围已准备；本文件中的运行时改造尚未实施。**
本文原名中的“顺序 2”是故障修复优先级，与原定 Agent 第二阶段混用了编号。
当前阶段划分见 [P1 收尾](qa-agent-stage-1-closeout.md)，完整 P2 方案见
[工具协议与模型自主查阅文档](qa-agent-stage-2-plan.md)。本文件只负责运行记录与失败控制。

基线为全文读取修复后的 `0.1.1-alpha.1`。F01 已统一 MathPix 读取接口，
通过 9 项新增回归、287 项全项目测试与构建；独立测试项目的原文档可直接读取全文。
源码 `1cc80bdd4cc71871b55d83175dee4ea9eca23804` 已部署本地 QA，全文路径人工验收通过，
真实模型的 long-context 成功落库已核对，见 [运行核验](qa-local-runs-2026-09-23.md)。
F02 将在这个已验证的正常路径上增加请求级记录与失败控制，不重复修复 F01 的字段契约。
下文 global → 全文 → 检索的分支规则适用于兼容旧路径；P2 新工具路径不默认回落旧语义检索，
其阶段、工具协议、引用迁移和预算以 P2 主文档为准，共用这里的唯一序号、取消与终态原则。

## 要解决的具体问题

一次 global 请求读取全文失败后，最终 Agent 回答可能成功。当前数据库只保留后半段，
无法回答“最初选了什么路径、在哪一步失败、为什么回落、到底调用了几次模型”。
本阶段让同一条消息保留完整行动轨迹，并避免用户取消、已输出正文或保存失败后再次启动模型。

已核对的代码约束：

| 位置 | 当前行为 | 实施要求 |
| --- | --- | --- |
| `server/routes/qa.mjs` | 全文 plan/outline/fallback 直接发 SSE，未入步骤表 | 所有分支共用事件记录器 |
| `server/qa/agent/loop.mjs` | 自建 `nextStepIndex=0`；终止动作先 break | 接受请求级事件上下文，记录真实结束原因 |
| `server/qa/agent/events.mjs` | 先入库再发送；`emit` 异常会传播 | 明确记录失败和传输失败的终止语义 |
| `supabase/schema.sql` | 步骤唯一键为 `(message_id, step_index)`；已有 `fallback` kind | 统一分配序号，不新增顶层 kind |
| `src/qa/PaperQaPanel.tsx` | `mergeAgentStep()` 按 id 或 stepIndex 覆盖旧步骤 | 回落与下一条 plan 不能复用序号；刷新后轨迹一致 |
| `server/qa/queryRouter.mjs` | 捕获模型异常后返回 detail，包括取消引起的异常 | 取消继续上抛；正常降级须保留原因 |
| `server/routes/qa.mjs` | 全文成功消息未传 usage；日志缺少实际开始时间 | 补齐该路径的消息用量与阶段计时 |

本阶段保留 `agent_step/gap_check/tool_call/observation` 等 SSE 名称与现有字段。
F02 单独实施不需要新增数据库表或枚举，不修改模型目录、翻译客户端、索引协议，不重建索引。
P2 的新工具名与阅读来源引用另有增量迁移要求，不能套用上述“不新增”范围。
跨轮 `lineRegions` 和证据身份归属 F03，由 P2 的证据与引用工作一并规划。

## 请求级运行上下文

在助手占位消息创建后建立一个上下文，由路由、全文分支、检索循环共享。
`messageId` 作为本次运行标识；重新生成会创建新助手消息，因此无需为本阶段另建运行表。
一次路径尝试有独立 `attemptIndex`，只允许全文 → 检索这一方向回落一次。

```js
{
  messageId, userId,
  nextStepIndex: 0,
  steps: [],
  phase: "routing",
  attemptIndex: 0,
  selectedPath: undefined,
  finalPath: undefined,
  answerStarted: false,
  providerOutputStarted: false,
  terminalStatus: undefined,
  controllerCalls: 0,
  usageByStage: [],
}
```

阶段固定为 `routing / fulltext_load / fulltext_generate / agent_retrieval / answer_generate / persist_answer / terminal`。
`answerStarted` 在第一段非空正文发送前设置；思考、usage 或 finish 等模型输出一旦发给前端，
也设置 `providerOutputStarted`，避免回落后两次模型的输出混在同一界面。

`nextStepIndex` 只由事件层递增。检索循环原有 `maxSteps` 是它自己的记录预算，不能再与全局序号比较；
需保留独立循环记录计数，路由步骤不消耗搜索/打开/控制器预算，终态记录不受循环记录上限压制。
默认组装入口可创建上下文，保证离线学习示例与单独调用循环仍可运行。

## 持久化与事件协议

沿用现有 `kind`，在 `payload` 内添加版本化的诊断字段：

| 动作 | kind | payload 主要内容 |
| --- | --- | --- |
| 问题分类完成或分类降级 | `plan` | `traceVersion`, `phase`, `questionType`, `routerFallback`, `selectedPath` |
| 全文读取开始/完成 | `observation` | `phase=fulltext_load`, `attemptIndex`, `state`, 起止时间、字符数、是否截断 |
| 允许回落 | `fallback`，status=error | 失败阶段、结构化错误码、简短错误摘要、from/to path、attemptIndex |
| finish/direct/预算结束 | `answer_outline` | 归一化终止动作或 `stopReason`、真实 controller/search/open 次数 |
| 请求结束 | `observation` | `phase=terminal`, `terminalStatus`, `finalPath`, 用量完整性与耗时摘要 |

`questionType` 只存归一化结果；错误摘要采用有界、脱敏文本，不复制请求头、密钥、提示词、论文正文或供应商原始响应。
所有新步骤必须带数据库返回的 id/createdAt，再发给前端。最终 `done` 与历史查询使用同一组步骤。
旧记录没有 `traceVersion` 时按旧格式读取；不根据历史成功结果补造路由或失败原因。

`user_qa_api_logs.request_kind` 目前只有五种值。本阶段保留原有每条消息的终态 `answer-stream` 记录，
不把每个阶段都伪装成额外的 `answer-stream`，避免设置页统计重复计算请求与用量。
阶段细节进入步骤 payload；终态日志 payload 汇总 selectedPath/finalPath/fallback、各阶段耗时和用量。
原有顶层 usage 继续表示最终答案调用；全链路用量放独立字段，并注明缺失项，不能把未知用量记为零。
全文成功路径的 message usage 同步补齐。路由器、控制器通过可选用量回调上报，不改变模型的动作 JSON。

现有 `writeQaLogSilent()` 只适合辅助 API 日志，不能承担必须可追溯的回落步骤。
关键步骤持久化失败则终止，不继续调用另一条模型路径；数据库本身故障时只能尽力保存终态，
并输出带 messageId 的脱敏服务端诊断，不能承诺数据库故障时轨迹仍完整。

## 回落规则与终止处理

不要继续用覆盖整个全文处理函数的大 catch。按阶段分类错误，由一个纯函数决定是否允许回落。
首版采用有限的错误类别，未知异常直接结束，避免把代码错误当作可恢复故障。

| 情况 | 行为 |
| --- | --- |
| 已授权文档的全文缓存缺失、损坏或读取暂时失败，尚无模型输出 | 记录原错误后，允许回落检索一次 |
| 用户/文档校验失败、字段契约错误、索引不可用 | 结束请求；检索依赖同一权限与索引，重复尝试没有意义 |
| 用户取消或客户端断开 | 终态为 aborted；不再执行分类降级、搜索或答案模型 |
| 模型调用失败但尚无输出 | 首版结束并保留原因；不把认证、限流或所有 4xx 自动归因于上下文过长 |
| 已发送正文、思考或其他模型输出后失败 | 结束当前尝试，标记失败；保留已生成正文，不拼接检索分支回答 |
| 答案生成完成，但保存消息失败 | 以 persist_answer 失败处理，尽力保存轨迹；不再次生成 |
| SSE 写失败或 response 已关闭 | 停止后续模型/工具执行，尽力持久化终态，不再次向坏连接写 error |

当前模型适配器把多数 4xx 合并成 `${provider}_api_error`，不能可靠辨认上下文超限。
后续若支持“全文过长 → 短证据回答”的模型错误回落，先增加经过验证的结构化错误分类，
再加入允许列表；本阶段不通过匹配供应商错误文案扩大回落范围。

每次 await 返回后、阶段切换前检查 signal，尤其是分类结果返回后。
终态出口只执行一次；同一运行只能发一次 done 或 error，不能 done 后又 fallback。
已产生正文发生故障时，历史消息保存部分内容和 error/aborted 状态，不能仅留下空占位。

## 建议实施顺序

1. **共享事件上下文**：新增 `server/qa/runContext.mjs`，调整 `agent/events.mjs`、`agent/loop.mjs` 和组装入口；
   先证明跨分支序号唯一、默认单独循环兼容、预算不会被前置事件缩减。
2. **路由与全文轨迹**：`routes/qa.mjs` 接入共享记录器；补齐分类、全文尝试、回落、终态和源码版本诊断。
   版本/SHA 从启动入口传入；开发态明确写 development，不伪装成确切运行 SHA。
3. **错误与终止策略**：新增 `server/qa/fallbackPolicy.mjs` 纯策略函数；缩小 try/catch；取消从 router 向外传播；
   统一保存部分答案、用量、最终路径和原失败阶段。
4. **轨迹查询与验收**：修复 `scripts/qa-trace.sql`，同步流程文档、变更记录，再完成测试项目的真实运行。
   SQL 仅在 `msg_id` 未定义时设默认值；耗时改为 `extract(epoch from interval) * 1000`；不要再将 gap_check 当作完整控制器调用表。

这些改动会增加可见步骤并收紧回落行为，按 0.x 功能版本规则随 P2 进入拟定的 **0.2.0-alpha.1**；
`0.1.1-alpha.1` 只承载 F01 的兼容修复。本次仅更新方案，运行时协议标识在实际修改时更新。

## 验证矩阵

| 场景 | 必须断言 |
| --- | --- |
| global 正常完成 | 仅分类和全文答案调用；轨迹有读取与终态；message/log 用量一致 |
| 全文缓存不可读 → 检索成功 | 原失败可查、回落恰好一次、序号无重复，finalPath=agent |
| 回落后检索也失败 | 两次失败阶段均保留，最终 status=error，无 done |
| router / 全文加载 / 模型等待 / 回落前取消 | 不再调用后续工具或模型；终态 aborted |
| 正文或思考输出后模型断流 | 不回落；不产生两份回答；部分正文与失败状态可重载 |
| 生成成功但保存失败 | 模型只调用一次；阶段为 persist_answer |
| 关键步骤入库失败、SSE 抛错 | 不掩盖原异常，不继续业务调用，不循环写失败事件 |
| 预算耗尽、finish、direct_answer | 终止原因与真实调用次数可直接读取，无须 gap_check + 1 推断 |
| 刷新会话、读取旧消息 | 已记录回落仍可见；旧 payload 无新增字段也能正常展示 |
| 指定 trace msg_id，耗时超过一分钟 | 查到指定消息；65.123 秒输出 65123 毫秒 |
| 非 QA 回归 | 翻译/阅读/文库/MathPix 与独立 QA 隔离检查通过 |

F01 新增的 `tests/qa/fullText.test.mjs` 已提供真实路由 + 合成数据库/模型响应的正常路径基线，
后续据此扩展阶段故障注入，另用纯单元测试验证回落策略、唯一序号和预算。
必须在独立测试项目完成一轮 global 成功与一轮受控回落，核对 SSE、数据库、历史重载一致后，
才能宣称旧路径的 F02 已验收；P2 还须通过主方案的新工具及无语义索引场景。
分支 CI、测试服务验收、生产部署保持独立记录。
