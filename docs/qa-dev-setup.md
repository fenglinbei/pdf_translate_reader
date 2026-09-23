# QA 开发环境：跑通一次真实问答

状态：无凭据部分已在本机验证；带凭据的步骤尚未执行，见文末清单。
规范约束见 [版本、CI/CD 与 QA 隔离规范](versioning-and-delivery.md)，本文只是操作步骤。

离线学习（`npm run demo:qa`）不需要本文任何一步。需要看真实检索、真实模型决策和真实 SSE 时才需要。

## 已验证的部分：不需要任何凭据

复制模板、改端口、启动服务、检查健康与路由隔离——这些在本机已经跑通：

```bash
cp .env.qa.example .env.qa.local
# 见下方"先改端口"
QA_ENV_FILE=.env.qa.local npm run dev:qa
```

预期结果：

| 检查 | 结果 |
| --- | --- |
| `GET /api/qa/health` | `{"status":"ok","service":"pdf-reader-qa","version":"0.1.0-alpha.1","sha":"development","environment":"development"}` |
| `/api/health`、`/api/translate/stream`、`/api/library/documents`、`/api/mathpix/jobs` | 全部 `404`（独立进程不服务主应用路由） |
| `GET /api/qa/threads` | `500 supabase_not_configured`（凭据为空时失败关闭，不崩溃） |

`sha` 为 `development` 是预期的：只有打包产物才带 `qa-release.json`，且 production 环境缺它会直接拒绝启动。

## 先改端口：8788 在本机已被占用

`.env.qa.example` 默认 `QA_PORT=8788`，但本机 8788 已被另一个无关项目（"青少年拒学风险 AI 初筛与社工接案系统"）监听。
不改端口会得到 `EADDRINUSE`。同时注意 8787 是主应用 API（`pdf-translate-reader-api`），不要占用或指向它。

```bash
# .env.qa.local
QA_PORT=8789
```

## 需要凭据的部分

`.env.qa.example` 里这些是空的，必须填。前四项决定能不能登录和落库，后两项决定能不能检索：

| 变量 | 用途 | 缺失时的表现 |
| --- | --- | --- |
| `SUPABASE_URL` | 测试项目地址 | `supabase_not_configured` |
| `SUPABASE_ANON_KEY` | 校验登录 token | 401 / 配置错误 |
| `SUPABASE_SERVICE_ROLE_KEY` | 索引任务、步骤与工具调用落库 | 落库失败，循环中断 |
| `DEEPSEEK_API_KEY` | 控制器与 `queryRouter` 调用 | 控制器调用失败，抛 `QaAgentRunnerError` |
| `VOYAGE_API_KEY` | 语义检索 embedding | 退化为纯文本检索 |
| `MATHPIX_APP_ID` / `MATHPIX_APP_KEY` | 论文解析，索引的上游 | 无法建索引 |

**必须用独立的 Supabase 测试项目和测试账号**：不复用 `.env.local` 里的生产凭据，模型额度也宜分开设置。
表结构用测试项目自己的 SQL editor 执行 `supabase/schema.sql`（增量用 `supabase/migrations/`），步骤与主应用一致，见 README 的 "Supabase setup"。
QA 依赖的表：`user_documents`、`user_paper_chunks`、`user_paper_references`、`user_mathpix_documents`、
`user_qa_threads`、`user_qa_messages`、`user_qa_citations`、`user_qa_agent_steps`、`user_qa_tool_calls`、`user_qa_index_jobs`、`user_qa_api_logs`。

## 建索引：循环能不能跑起来的前提

没有索引时 `retrieveEvidence` 无据可查，只能看到空证据轨迹。文档规定测试索引要显式请求
（`QA_INDEX_WORKER_ENABLED=true` 只控制**启动时的恢复**，不是禁写开关）：

1. 先让该文档完成 MathPix 解析（主应用侧流程）。
2. 再请求建索引，`source` 目前只接受 `mathpix-v3-pdf`：

```bash
curl -X POST http://127.0.0.1:8789/api/qa/index-jobs \
  -H "Authorization: Bearer <测试账号 token>" \
  -H "Content-Type: application/json" \
  -d '{"userDocumentId":"<uuid>","source":"mathpix-v3-pdf"}'
```

首次返回 `201`，已存在则 `200` 且 `reused: true`。用 `GET /api/qa/index-jobs` 查状态。

## 前端：看实时 SSE

```bash
# 开发前端环境
VITE_QA_API_PROXY_TARGET=http://127.0.0.1:8789
```

`vite.config.ts` 只把 `/api/qa/` 转到测试服务，其余 `/api/` 仍走主应用。
这个开关只解决代理转发，**不解决登录**：测试项目需要匹配的前端登录会话，
不要用生产登录 token 去访问另一个 Supabase 项目。

联调时主应用建议设 `QA_EMBEDDED_ENABLED=false`，避免两个索引 worker 同时运行。

## 观察点

进入前端问答后，按 [执行内核说明](qa-agent-runtime.md) 的分流图先确认问题类型：

- 问"总结这篇论文"→ 走长上下文路径，**看不到 `tool_call`**，这是预期。
- 问一个具体事实 → 进入执行循环，SSE 依次出现 `agent_step`(plan) → `gap_check` → `tool_call` → `observation` → … → `agent_step`(answer_outline)。
- 服务端日志里 `[query-router]` 打出了分类原始返回，`[qa-stream] questionType =` 打出了最终分流结果，两者对照可以看清决策过程。

## 待办清单

- [x] `.env.qa.local` 建立并避让端口冲突（本机已验证）
- [x] 无凭据启动、健康检查、路由隔离（本机已验证）
- [ ] 独立 Supabase 测试项目与测试账号
- [ ] 用测试项目执行 `supabase/schema.sql`
- [ ] 填入 6 个凭据变量
- [ ] 完成一篇论文的 MathPix 解析并请求建索引
- [ ] 前端测试项目登录会话，跑通一次真实问答
- [ ] 分别验证 `detail` 与 `global` 两条路径的实际事件差异
