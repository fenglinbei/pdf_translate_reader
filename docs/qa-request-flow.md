# 一次 QA 请求的逻辑图

对着 `server/routes/qa.mjs`、`server/qa/agent/loop.mjs` 和 `server/qa/queryRouter.mjs` 画的实际流程。
这是**逻辑**（任何一次运行都成立），不是某次运行的数据；具体查询词、证据编号、轮数因问题而异。

`detail` 与 `global` 是两条完全不同的路径，差别在第 6 步那一个分支。

## 共同前置：两条路径都走这一段

```mermaid
flowchart TD
    A["浏览器 POST /api/qa/stream<br/>（前端代理到 QA 服务 8789）"] --> B["httpServer：非 /api/qa/* 一律 404"]
    B --> C["requireAuthenticatedUser<br/>用测试项目校验 Bearer token"]
    C --> D["复用或新建 user message<br/>insertQaMessage(role=user)"]
    D --> E["insertQaMessage(role=assistant, status=streaming)<br/>先占位，最后再 update"]
    E --> F["写 SSE 头 + 每 10 秒 keep-alive"]
    F --> G["SSE meta<br/>{assistantMessageId, model, promptVersion, ...}"]
    G --> H["classifyQuestionType()<br/>★ 第 1 次模型调用，temperature=0"]
    H --> I{"questionType.type"}
    I -->|global| LC["长上下文路径<br/>handleLongContextAnswer()"]
    I -->|"detail / follow_up / chitchat"| AG["执行循环<br/>runCurrentPaperReasoningRetrieval()"]
    LC --> Z["共同收尾"]
    AG --> Z
```

第 1 次模型调用就是路由器，它的原始返回打在终端 2 的 `[query-router]`，最终分流结果打在 `[qa-stream] questionType =`。

## 路径 A：`detail` 问题 —— 进执行循环

```mermaid
sequenceDiagram
    autonumber
    participant B as 浏览器
    participant R as routes/qa.mjs
    participant L as 执行循环 loop.mjs
    participant M as 控制器（模型）
    participant T as 工具 + 检索
    participant E as 事件记录 events.mjs
    participant P as Postgres

    R->>L: 问题、已授权 userId/userDocumentId、chatContext
    L->>E: recordStep(plan)<br/>payload: budget + queryPlan + chatContext
    E->>P: insert user_qa_agent_steps[0]
    E-->>B: SSE agent_step

    loop turnIndex < budget.maxControllerCalls（quick 2 / standard 4 / deep 7）
        L->>M: 当前证据 + 已打开证据 + 工具历史 + 剩余预算
        M-->>L: JSON 动作
        Note over L: normalizeControllerAction()<br/>白名单：两个工具 + finish + direct_answer<br/>非法动作 → 抛错终止
        L->>E: recordStep(gap_check)<br/>payload.action = 归一化后的模型决定
        E-->>B: SSE gap_check

        alt search_current_paper
            L->>T: {query, matchCount}
            Note over T: 检索 = 全文匹配 + 向量召回 + 重排<br/>userId/userDocumentId 来自可信上下文，<br/>模型传的同名字段被忽略
            T->>E: recordStep(tool_call) + recordToolCall()
            E->>P: user_qa_agent_steps + user_qa_tool_calls<br/>（含完整 input jsonb）
            E-->>B: SSE tool_call
            T-->>L: 新证据，mergeEvidence 后重新编号 C1..Cn
            L->>E: recordStep(observation)
            E-->>B: SSE observation
        else open_chunk
            L->>T: {evidenceIds}
            Note over T: 只从本次运行已持有的证据里取，<br/>不按模型给的任意 ID 查库
            T->>E: recordStep(tool_call) + recordToolCall()
            E-->>B: SSE tool_call
            L->>E: recordStep(observation)
            E-->>B: SSE observation
        else finish_retrieval / direct_answer
            Note over L: 跳出循环
        end
    end

    Note over L: 预算到顶时由代码 break，<br/>不依赖模型自觉
    L->>E: recordStep(answer_outline)<br/>selectFinalEvidence()
    E-->>B: SSE agent_step
    L-->>R: {evidence, agentSteps, diagnostics, warnings}

    R->>M: streamQaChatCompletion(证据包 + 问题)<br/>★ 第 N+2 次模型调用
    M-->>B: SSE delta / thinking / usage / finish
    R->>R: verifyAnswerCitations(answerText, evidence)
    R->>P: insert user_qa_citations
    R-->>B: SSE verifier
    R->>P: updateQaMessage(status=success, retrieval_snapshot)
    R-->>B: SSE done
```

**这次请求的模型调用次数** = 1（路由）+ 循环轮数（≤ `maxControllerCalls`）+ 1（答案生成）。
一次 `deep` 提问最多 7 轮控制器，所以单次提问可以接近 10 次模型调用。

## 路径 B：`global` 问题 —— 绕过循环

```mermaid
sequenceDiagram
    autonumber
    participant B as 浏览器
    participant R as routes/qa.mjs
    participant F as 全文加载
    participant M as 模型
    participant P as Postgres

    Note over R: questionType.type === "global"
    R->>R: 打日志 [qa-stream] -> long context path
    R->>F: loadCurrentPaperFullText(userDocumentId, userId, model)
    F-->>R: 整篇正文（上限 QA_LONG_CONTEXT_MAX_CHARS，默认 240000）
    R->>R: createRetrievalSnapshot({ evidence: [] })<br/>retrieverVersion = "long-context"
    R->>R: 本地构造 planStep + outlineStep
    Note over R: 这两个步骤是直接构造的：<br/>没有经过模型决策，<br/>也**不写 user_qa_agent_steps**（没有 id / createdAt）
    R->>B: SSE agent_step ×2
    R->>B: SSE retrieval<br/>{ diagnostics.agent.longContext = true, candidateCount: 0 }

    R->>M: streamQaChatCompletion(全文 + 问题)<br/>★ 第 2 次模型调用，也是最后一次
    M-->>B: SSE delta / thinking / usage / finish
    R->>R: verifyAnswerCitations(answerText, evidence = [])
    Note over R: evidence 为空 → 答案里任何 [C1] 都会被<br/>判为 rejected（citation_not_in_retrieval），<br/>所以这条路径**给不出可点回的引用**
    R->>P: insert user_qa_citations（通常为空）
    R-->>B: SSE verifier
    R-->>B: SSE done

    Note over R: 失败时才回落：<br/>发一个 kind=fallback 的 agent_step，<br/>然后走路径 A
```

**这次请求的模型调用次数** = 2（路由 + 全文答案）。**没有任何 `tool_call`。**

## 两条路径的差别

| | 路径 A（detail） | 路径 B（global） |
| --- | --- | --- |
| 触发条件 | `questionType.type !== "global"` | `=== "global"` |
| 进入执行循环 | 是 | **否** |
| `tool_call` 事件 | 有（≤ `maxRetrievalCalls` 次检索 + ≤ `maxOpenCalls` 次打开） | **没有** |
| `gap_check` 事件 | 有，每轮一个 | 没有 |
| 额外 SSE 事件 | — | 多一个 `retrieval` |
| 证据来源 | 向量检索 + 重排，逐轮累积 | 无（`evidence: []`） |
| 可点回的引用 | 有，`citationVerifier` 逐条校验 | **没有**，引用一律 rejected |
| 模型调用次数 | 1 + 循环轮数 + 1 | 2 |
| **步骤是否落库** | **是**，每步写 `user_qa_agent_steps` | **否**，只走 SSE |
| 失败行为 | 抛 `QaAgentRunnerError`，带已完成步骤 | 回落到路径 A |

注意最后第二行：路径 B 的 `plan` / `answer_outline` 是本地构造的对象，**没有 `id` 也没有 `createdAt`**，
从不写库。所以对它跑 trace 脚本时第 1、2、3 节会是空的——**这正是区分两条路径最快的办法**。

## 怎么用真实数据核对这张图

上面是逻辑。要把你**实际那两次**的查询词、证据编号、轮数填进来，跑：

```bash
# 最近一次
psql -p 5432 -d postgres -f scripts/qa-trace.sql

# 指定某次
psql -p 5432 -d postgres -v msg_id=<uuid> -f scripts/qa-trace.sql
```

| trace 的哪一节 | 对应图里的什么 |
| --- | --- |
| 第 0 节 | 共同前置：确认 `model` / `prompt_version` / `usage` |
| 第 1 节 | 路径 A 的完整步骤时间线；**路径 B 这里为空** |
| 第 2 节 | 路径 A 的循环体：`turn` / `model_action` / `rewritten_query` |
| 第 3 节 | 路径 A 的 `tool_call` 几步：入参、返回证据、耗时 |
| 第 4、5 节 | 证据 C 编号 → chunk → 正文 |
| 第 6 节 | 收尾的引用校验产物 |

再确认一次：这份文档写的是**逻辑**，不是你那两次运行的具体数据。要我把真实值填进图里，
把 trace 的输出贴给我就行（那个脚本不打印密钥）。

## 读真实轨迹时的四个陷阱

下面四条是拿一次真实运行核对这张图时才发现的，光读代码不容易注意到。

### 1. `C1` 在不同步骤里可能指不同的证据

`mergeEvidence()` 最后一步是**按分数降序重新编号**：

```js
return deduped
  .sort((left, right) => Number(right.score) - Number(left.score))
  .map((item, index) => ({ ...item, evidenceId: `C${index + 1}` }));
```

所以 `plan` 步骤 `evidence_ids` 里的是**上一轮的编号**（带入的证据，沿用上轮 message 的快照），
而 `observation` 之后的是**本次合并重排后的新编号**。同一个 `C1`，在两个步骤里未必是同一条 chunk。
比对时要认 `chunk_id`，不要认 `C` 号。

### 2. `finish_retrieval` 不留任何步骤

`loop.mjs` 里判断在记录之前：

```js
if (action.action === "finish_retrieval") { finishAction = action; break; }  // ← 先跳出
await events.recordStep(state, "gap_check", { ... });                        // ← 走不到
```

于是**模型"决定收工"这个动作在步骤时间线里是查不到的**，只能从 `answer_outline` 的
`payload.answerOutline` 反推（它就是 finish 动作带回来的大纲）。

推论：`gap_check` 的数量 **等于**实际控制器轮数减一。有 1 个 `gap_check` 就说明跑了 2 轮控制器
（最后一轮是 finish）。想看准确轮数，得看 `diagnostics`（api_logs 里）或服务端日志。

### 3. 光看数据库分不清路由选了哪条路

一个问题走**路径 A**，有两种可能：

- router 判成 `detail` / `follow_up` / `chitchat`，直接进循环
- router 判成 `global`，但长上下文失败，**回落**进循环

两者的数据库痕迹**完全一样**。因为回落的那个 `kind: "fallback"` 步骤只 `writeSse`，
从不落库——而且它写的是 `stepIndex: 0`，与循环的 plan 步骤撞 `unique (message_id, step_index)`，
这也反证了它没落库。

唯一判据在服务端日志：

```
[query-router] {"normalizedType":"global", ...}
[qa-stream] questionType = global | question: ...
[qa-stream] -> long context path        ← 有这行才是真的走了长上下文
```

#### 实测案例：路由判对了，但长上下文失败了

一次真实运行里，`「这篇文章主要讲了什么？」` 的日志是：

```
[query-router] {..."normalizedType":"global","confidence":"high"...}
[qa-stream] questionType = global | question: 这篇文章主要讲了什么？
[qa-stream] -> long context path
[qa-stream] evidence lineRegions check: [ ...C1..C10... ]     ← 这行属于 agent 路径
```

路由**判对了**（global，high 置信度），也确实进了长上下文路径，但随后出现了属于 agent 路径的日志
——说明长上下文抛错并静默回落了。数据库里只看得到 agent 循环的痕迹，看不出发生过回落。

**失败原因是不可观测的**：回落处既没有 `console.error`，也没有写库，
`errorMessage` 只存在于那一刻的 SSE 流里（渲染时前端只显示 `summary`，所以界面上也看不到）。
要当场看到它，只能开浏览器 DevTools → Network → `/api/qa/stream` 的 EventStream。

还有一个可推断的信号：该请求的 `chatContext.carryoverEvidenceIds = ["C1","C2"]`。
长上下文路径写入的快照是 `evidence: []`，所以**上一轮只要走了长上下文，这一轮就不会有带入证据**。
带入证据存在，说明上一轮同样走的是 agent 循环——**两轮都回落了，这是系统性失败，不是偶发**。

### 4. agent 路径的 `questionType` 不落库

`questionType` 只出现在两处：`console.log`，以及长上下文路径的步骤 payload / diagnostics。
`user_qa_api_logs` 的 payload 只有 `chatContext` / `diagnostics` / `evidenceCount` / `queryPlan` / `warnings`。

所以"这个问题为什么没走长上下文"**事后无法从数据库回答**，必须翻服务端日志。
这是当前的一个可观测性缺口。
