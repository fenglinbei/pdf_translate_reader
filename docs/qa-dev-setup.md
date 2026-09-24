# QA 开发环境：跑通一次真实问答

P2 使用 `QA_AGENT_RUNTIME=document-tools-v1`：MathPix 原文可读即可问答，无需建立 QA 索引或配置 Voyage。首次启动前必须给**独立测试库**应用 [兼容迁移](../supabase/migrations/20260924_qa_document_tools.sql)，再用 `node --env-file=.env.qa.local scripts/check-qa-document-schema.mjs` 检查。部署和人工验收步骤见 [P2 实施记录](qa-agent-stage-2-implementation.md)。下文涉及 QA 索引/Voyage 的步骤只用于显式旧路径。

状态（2026-09-24 更新）：P2 已完成测试库迁移、本地部署和合成资料的真实问答/落库/浏览器定位验证，QA 版本 `0.2.0-alpha.3`，默认 DeepSeek V4.1 Flash；真实论文人工验收待进行。详见 [本地部署记录](qa-agent-stage-2-local-deployment.md)。
P1 全文修复的历史人工验收见 [两轮真实运行核验](qa-local-runs-2026-09-23.md)，当时验收源码为 `1cc80bdd4cc71871b55d83175dee4ea9eca23804`。
当前验收 QA 从独立发布目录运行，进程和日志位置见本地 `output/qa-local-server/deployment.json`；修改工作区不会自动更新这个进程。恢复源码调试时先停止验收 QA，再按下面命令启动，避免重复占用 8789。
规范约束见 [版本、CI/CD 与 QA 隔离规范](versioning-and-delivery.md)，本文只是操作步骤。
2026-09-24 [P1 已收尾](qa-agent-stage-1-closeout.md)；[P2 工具协议与自主查阅方案](qa-agent-stage-2-plan.md) 已实施。当前可直接打开 `https://127.0.0.1:5174` 测试；下面的启动命令供重新建立环境或切回源码调试时使用。

离线学习可运行 `npm run demo:qa-document`（原生工具）或 `npm run demo:qa`（旧循环），无需配置凭据。需要看真实模型决策、数据库记录和 SSE 时再使用本文环境。

## 启动流程

一次性准备只做一次；之后日常就是"三个终端 + 验收"。

### 一次性准备

1. 建独立 Supabase 测试项目、执行 `supabase/schema.sql`、建测试账号 → 见 [建立独立的 Supabase 测试项目](#建立独立的-supabase-测试项目)。
2. 填 `.env.qa.local` 并跑 `npm run check:qa-env` 确认通过 → 见 [配置文件](#配置文件)。
3. 在测试项目里完成一篇论文的 MathPix 解析；原生文档工具模式到此即可提问，只有显式旧路径需要继续[建索引](#旧路径建索引)。

### 每个终端各起一个进程

三个进程必须指向**同一个**测试项目，否则会出现 401——原因见 [关键：整条栈必须指向同一个测试项目](#关键整条栈必须指向同一个测试项目)。

**终端 1 — 主应用（8790，指向测试项目）**

```bash
cd /home/fenglin/project/pdf_translate_reader
PORT=8790 QA_EMBEDDED_ENABLED=false node --env-file=.env.qa.local server/index.mjs
```

`--env-file` 把 `.env.qa.local` 注入 `process.env`，而命令行变量优先级高于文件，
所以 `PORT` / `QA_EMBEDDED_ENABLED` 由命令行决定，Supabase 与模型凭据来自测试文件——**不会动到 `.env.local`**
（`server/index.mjs` 在加载 `.env` / `.env.local` 之后会把 `process.env` 恢复回去）。
`QA_EMBEDDED_ENABLED=false` 关掉内嵌 QA 路由与索引恢复，避免两个索引 worker 同时跑。

⚠️ **`--env-file` 会把文件里的空值也一并注入，并遮蔽 `.env.local` 的同名变量。**
模板里 `DEEPSEEK_API_KEY=` 和 `VOYAGE_API_KEY=` 是空的，所以在你填之前，这个测试实例**没有任何模型可用**。
本机实测未填时的表现：`deepseek.apiKeyConfigured=false`、`embedding.configured=false`。
只有 `.env.qa.local` 里**没有出现**的变量（如 GLM / Kimi / Qwen 的 key）才会从 `.env.local` 继承。

验证：

```bash
curl -s localhost:8790/api/health
```

- `supabase.configured` 必须是 `true`——是 `false` 就说明凭据没读到，别继续往下走。
- 只有旧索引/混合检索路径需要 `embedding.configured=true`；新文档工具路径不依赖 embedding。
- `curl -s localhost:8790/api/qa/threads` 应返回 `503 qa_disabled`，证明内嵌 QA 已按预期关闭。

**终端 2 — QA 服务（8789）**

```bash
cd /home/fenglin/project/pdf_translate_reader
QA_ENV_FILE=.env.qa.local npm run dev:qa
```

验证：`curl -s localhost:8789/api/qa/health`

**终端 3 — QA 前端（5174，`--mode qa`）**

```bash
cd /home/fenglin/project/pdf_translate_reader
npm run dev:web -- --mode qa --port 5174 --strictPort
```

`--mode qa` 让 Vite 加载 `.env.qa.local` 并**覆盖** `.env.local`；不加这个参数前端会继续连生产项目。
本机已实测：`mode=qa` 命中 `.env.qa.local`，默认 `development` 模式不受影响。

本机主前端使用 5173，QA 前端固定为 5174；`--strictPort` 防止端口冲突时静默换端口。两个前端指向不同的 Supabase 项目，测试时使用 5174 和测试账号。

### 验收顺序

1. **三个健康检查**：`http://127.0.0.1:8789/api/qa/health`、`http://127.0.0.1:8790/api/health`、`https://127.0.0.1:5174` 都能打开；QA 健康信息的 runtime 为 `document-tools-v1`。
2. **确认前端连的是测试项目**：浏览器登录测试账号。若此时翻译/文库报 401，就是终端 1 或终端 3 没指向测试项目。
3. 选择 MathPix 已完成的文档，确认显示“文档已就绪，可提问”；无需建索引。
4. 提一个实现方式问题，观察模型使用 `get_document_outline`、`search_document_text`、`read_document`、`finish_reading` 中适合的工具；不是每次都必须调用全部工具。
5. 确认回答保存成功；刷新并打开问答面板，点击引用，核验章节标签和关键句所在原文行高亮。

显式切回 `legacy-json-v1` 后才需要构建 QA 索引，并使用原来的 detail 检索/global 全文分支。

## 启动检查与离线验证

无凭据时可运行离线示例和测试。真实独立 QA 服务启动前会检查测试库引用字段；缺少 Supabase 配置或 P2 迁移时拒绝监听端口。
正常启动后，`/api/qa/health` 返回服务版本、源码 SHA 和 runtime；未登录访问 `/api/qa/threads` 返回 401。
独立 QA 服务上的 `/api/health`、`/api/translate/stream`、`/api/library/documents`、`/api/mathpix/jobs` 均返回 404。
源码调试的 `sha` 为 `development`；独立制品从 `qa-release.json` 读取确切 SHA，production 环境缺少该文件时拒绝启动。

## 先改端口：8788 在本机已被占用

`.env.qa.example` 默认 `QA_PORT=8788`，但本机 8788 已被另一个无关项目（"青少年拒学风险 AI 初筛与社工接案系统"）监听。
不改端口会得到 `EADDRINUSE`。同时注意 8787 是主应用 API（`pdf-translate-reader-api`），不要占用或指向它。

```bash
# .env.qa.local
QA_PORT=8789
```

## 配置文件

一个 `.env.qa.local` 同时喂三个进程：QA 服务直接用（`QA_ENV_FILE`），主应用用 `--env-file`，
前端用 `--mode qa`（[已验证](#每个终端各起一个进程)）。它被 `.gitignore` 的 `.env.*.local` 覆盖，不会进版本库。

需要填的值：

```bash
QA_ENVIRONMENT=development
QA_PORT=8789                  # 必须避开本机已被占用的 8788
QA_AGENT_RUNTIME=document-tools-v1
QA_INDEX_WORKER_ENABLED=false # 保持 false：只控制启动恢复，不打开就不会认领别人的任务
SUPABASE_URL=https://<测试项目>.supabase.co
SUPABASE_ANON_KEY=<测试 anon>
SUPABASE_SERVICE_ROLE_KEY=<测试 service_role>
DEEPSEEK_API_KEY=<建议用独立额度>
VOYAGE_API_KEY=<仅旧索引/混合检索路径需要>

# 前端（--mode qa 时生效）
VITE_SUPABASE_URL=https://<同一个测试项目>.supabase.co
VITE_SUPABASE_ANON_KEY=<同一个测试 anon>
VITE_QA_API_PROXY_TARGET=http://127.0.0.1:8789
VITE_API_PROXY_TARGET=http://127.0.0.1:8790
```

两处必须**指向同一个测试项目**：`SUPABASE_URL` 与 `VITE_SUPABASE_URL`。
前端拿哪个项目的 token，QA 服务就用哪个项目校验——不一致的表现是全部 401。

填完先跑预检，它会替你抓出上面这些不一致，以及一个更危险的情况：

```bash
npm run check:qa-env
```

它读 `.env.qa.local`（可用 `QA_ENV_FILE` 覆盖），全部通过时退出 0。检查内容：

| 检查 | 为什么 |
| --- | --- |
| 新路径 6 个必要配置，旧路径额外要求 Voyage | `--env-file` 会注入空值并遮蔽 `.env.local`，空着不会自动回落 |
| `SUPABASE_URL` 以 `https://` 开头 | 少协议头时 `createClient` 的报错很难懂 |
| `SUPABASE_URL` == `VITE_SUPABASE_URL` | 不一致 → 全部 401 |
| `SUPABASE_ANON_KEY` == `VITE_SUPABASE_ANON_KEY` | 同上 |
| 两个 key 的 JWT `role` 归属正确 | 填反了的表现是权限错误，不是配置错误 |
| `VITE_SUPABASE_ANON_KEY` 不是 `service_role` | **填错等于把 service_role 打包进浏览器**，它绕过所有 RLS |

最后一条是唯一标 `FATAL` 的：`anon` 和 `service_role` 在 Dashboard 上长相接近，贴串位置不会有任何报错，
但那个 key 会进前端产物。发现它是 `FATAL` 就立刻去 Dashboard 轮换该 key。

新格式的 `sb_publishable_` / `sb_secret_` 不是 JWT，解析不出角色，脚本会标 `NOTE` 而不是报错。

## 建立独立的 Supabase 测试项目

### 1. 创建项目

Supabase Dashboard 新建项目：独立名称（如 `pdf-reader-qa-test`）、独立数据库密码、就近区域。
**不要复用主应用的项目**——测试数据、Auth 用户和模型额度都要分开。

### 2. 取三个凭据

Settings → API Keys（老项目在 Settings → API）。需要：

| 值 | 用途 | 环境变量 |
| --- | --- | --- |
| Project URL | 服务端与前端都要 | `SUPABASE_URL` |
| anon / publishable key | 校验登录 token | `SUPABASE_ANON_KEY` |
| service_role / secret key | 索引任务、步骤与工具调用落库 | `SUPABASE_SERVICE_ROLE_KEY` |

Supabase 正在用 `sb_publishable_*` / `sb_secret_*` 取代 `anon` / `service_role`，两者目前并存可用
（[迁移说明](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)）。
本仓库锁定的 `@supabase/supabase-js@2.49.8` 早于新格式；此前实测**用两种格式构造客户端都不报错**。
现有测试项目凭据已通过真实问答与本次只读查询；这不等于两种 key 格式均完成了完整往返验证。
另外 `supabase/schema.sql` 的钩子是 Postgres 函数、不使用 `pg_net`，
所以"新 secret 键会被数据库 Webhook 拒绝"那个限制在这里不适用。

### 3. 建表

在测试项目的 SQL editor 执行 `supabase/schema.sql`。它建出 QA 依赖的全部表：
`user_documents`、`user_paper_chunks`、`user_paper_references`、`user_mathpix_documents`、`user_qa_threads`、
`user_qa_messages`、`user_qa_citations`、`user_qa_agent_steps`、`user_qa_tool_calls`、`user_qa_index_jobs`、`user_qa_api_logs`。

### 4. 注册限制：schema 只定义函数，不启用钩子

`schema.sql` 定义了**两个** Before User Created 钩子函数，但**默认都不生效**——必须在
Dashboard → Authentication → Hooks 里显式启用其中一个：

- `public.hook_restrict_signup_by_invite_ticket`（README 记录的邀请码流程）
- `public.hook_restrict_signup_by_email_allowlist`（邮件白名单）

测试项目最省事的做法是**两个都不启用**，直接建号。要复刻生产的邀请制再启用邀请码钩子。

### 5. 建测试账号

未启用钩子时：Dashboard → Authentication → Users → Add user，勾选 auto confirm；
或关闭 Authentication → Sign In / Providers → Email 的 Confirm email 后走普通注册。

若启用了邀请码钩子，必须走完整流程，否则建号会被钩子拒绝：

```sql
insert into public.signup_invites (code_hash, note, max_uses, expires_at)
values (public.hash_signup_invite_code('QA-TEST-2026'), 'qa test', 5, now() + interval '30 days');
```

然后 `POST /api/auth/invite-ticket`（带 email 与 inviteCode）换一张 10 分钟 ticket，注册时消费它。
注意这个接口在**主应用**（`server/index.mjs`）上，不在 QA 服务里——QA 服务只服务 `/api/qa/*`。

### 其余变量

`DEEPSEEK_API_KEY` 用于默认模型；`VOYAGE_API_KEY` 只用于旧索引/混合检索路径。
模型额度建议与生产分开，避免共享额度被翻译任务耗尽。
`MATHPIX_APP_ID` / `MATHPIX_APP_KEY` 用于主应用侧的新解析任务；原生 QA 读取已有解析缓存，不会重新调用 MathPix。

## 关键：整条栈必须指向同一个测试项目

这是最容易踩的坑。规范里"测试项目需要匹配的前端登录会话"说的是它，但没说清楚要牵连多少东西。

前端用 `VITE_SUPABASE_URL` 登录拿 token，QA 服务用 `SUPABASE_URL` 校验同一个 token；两者不同项目 → QA 请求全部 401。

更麻烦的是第二层：前端一旦登录测试项目，所有 `/api/`（翻译、文库、MathPix）请求仍转到主应用，
而主应用按**它自己**的 `SUPABASE_URL` 校验同一个 token。主应用若还指着生产项目，这些请求同样 401。

所以完整联调要三个进程一起指向测试项目：

| 进程 | 指向测试项目的方式 |
| --- | --- |
| 主应用 API | 用进程环境变量另起一个实例，不动 `.env.local` |
| QA 服务 | `QA_ENV_FILE=.env.qa.local` |
| 开发前端 | `vite --mode qa`，Vite 叠加加载 `.env.qa.local` |

主应用支持这么做：`server/index.mjs` 先备份 `process.env`，加载完 `.env` / `.env.local` 后再覆盖回去，
因此**命令行传入的变量优先级高于 `.env.local`**。同一个 `.env.qa.local` 也能喂给前端，
因为 `server/supabase/config.mjs` 同时接受 `SUPABASE_URL` 与 `VITE_SUPABASE_URL` 两套名字。

```bash
# 主应用第二个实例（8790），不修改 .env.local
SUPABASE_URL=<测试项目> SUPABASE_ANON_KEY=<测试 anon> SUPABASE_SERVICE_ROLE_KEY=<测试 service_role> \
  DEEPSEEK_API_KEY=<独立额度> PORT=8790 node server/index.mjs

# QA 服务（8789）
QA_ENV_FILE=.env.qa.local npm run dev:qa

# 前端：加载 .env.qa.local，/api/qa/ → 8789，/api/ → 8790
npm run dev:web -- --mode qa
```

不这样做也能跑：只让前端登录测试项目、用它看 QA 面板，代价是翻译与文库功能 401。
学习 Agent 流程够用，但别误判成"升级把主应用弄坏了"。

## 旧路径建索引

下面仅适用于 `legacy-json-v1`。没有索引时 `retrieveEvidence` 无据可查，只能看到空证据轨迹。测试索引要显式请求
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

前端配置见上一节"整条栈必须指向同一个测试项目"，要点是 `VITE_QA_API_PROXY_TARGET` 只影响
`vite.config.ts` 里 `/api/qa/` 这一条代理规则，**不解决登录**；登录由 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
决定，且必须与 QA 服务校验 token 用的项目一致。

联调时主应用建议设 `QA_EMBEDDED_ENABLED=false`，避免两个索引 worker 同时运行。

## 观察点

原生路径的流程图与学习入口见 [P2 实施记录](qa-agent-stage-2-implementation.md)。在“检索过程”面板查看实际阅读工具及观察结果；在数据库查看每次模型调用、工具入参、缓存命中和终态。

显式使用旧执行器时，可对照 [P1 请求流程](qa-request-flow.md) 与 [执行内核说明](qa-agent-runtime.md) 理解原来的分流：

- 问"总结这篇论文"→ 走长上下文路径，**看不到 `tool_call`**，这是预期。
- 问一个具体事实 → 进入执行循环，SSE 依次出现 `agent_step`(plan) → `gap_check` → `tool_call` → `observation` → … → `agent_step`(answer_outline)。
- 服务端日志里 `[query-router]` 打出了分类原始返回，`[qa-stream] questionType =` 打出了最终分流结果，两者对照可以看清决策过程。

## 想看清每次交互和工具参数：查库，不要靠界面

界面的「检索过程」面板只渲染 `summary` 和证据编号，**看不到工具入参和 payload**。完整数据都在数据库里：

| 想看什么 | 存在哪 |
| --- | --- |
| 每一步的类型、摘要、证据编号 | `user_qa_agent_steps` |
| **每一步的完整 payload** | `user_qa_agent_steps.payload`（jsonb） |
| **模型选择的工具与参数** | 原生路径：`user_qa_tool_calls.tool_name/input`；旧路径：`gap_check.payload->'action'` |
| **工具调用的完整入参** | `user_qa_tool_calls.input`（jsonb） |
| **工具返回了什么证据** | `user_qa_tool_calls.result_evidence_ids` |
| 工具耗时、报错 | `user_qa_tool_calls.started_at/finished_at/error_message` |
| **证据正文与来源身份** | `user_qa_messages.retrieval_snapshot->'evidence'`；原生路径为文档版本/evidenceKey/原文定位，旧路径为 chunk |
| 引用校验结果 | `user_qa_citations` |
| 每次模型调用耗时、用量与阶段 | `user_qa_api_logs` 中 `request_kind='model-call'` 的记录 |
| 最终状态与停止原因 | `user_qa_api_logs` 中 `answer-stream` 的 status/payload，以及消息 status/error_message |

`scripts/qa-trace.sql` 把这七块一次性打出来（本机用合成数据验证过全部语句）：

```bash
# 最近一次问答
psql -p 5432 -d postgres -f scripts/qa-trace.sql

# 指定某次
psql -p 5432 -d postgres -v msg_id=<uuid> -f scripts/qa-trace.sql
```

连接参数沿用前面那套 `PGHOST` / `PGUSER` / `PGPASSWORD`。第 0 节会回显取到的消息，先确认目标对了再往下看。

脚本第 2 节的 `turn/model_action/rewritten_query` 适用于旧 JSON 控制器。原生路径从工具调用的 input、步骤 payload 中的 callId，以及逐次模型日志的 phase/callIndex 关联轨迹。

### 有一层是查不到的

完整规划消息与原始供应商响应不单独落库；最终回答、工具参数及选中的原文引用正常保存。模型私有推理只在本次原生协议续接所需的内存上下文中保留。
学习消息结构可运行 `npm run demo:qa-document` 查看合成示例；真实运行以业务轨迹、工具记录和逐调用用量为准。

## 待办清单

- [x] `.env.qa.local` 建立并避让端口冲突（本机已验证）
- [x] P1 无凭据隔离测试的历史记录；P2 真实启动改为必须通过数据库预检
- [x] 独立 Supabase 测试项目已配置（与主应用配置的项目不同）
- [x] 本轮所需 QA 表与数据可查询（不据此宣称完整 schema / 钩子配置全部验收）
- [x] 测试凭据已填入 `.env.qa.local`；前后端项目配置一致
- [x] 测试账号完成真实提问，消息、步骤、工具和引用已落库
- [x] 本地 QA 8789 与测试主应用 8790 健康检查通过，主应用内嵌 QA 已关闭
- [x] 论文 MathPix 解析来源的索引为 `ready`，真实使用语义检索与重排
- [x] 两轮真实问答均成功落库，Agent 搜索与 `open_chunk` 已执行
- [ ] 全部 SSE 事件逐项复验（全文路径已人工验收，但未逐条核对所有事件及异常场景）
- [x] 全文读取字段契约修复；原测试文档的实际只读加载通过
- [x] global 完整路由合成回归：全文输入模型、答案保存、没有回落
- [x] 长上下文真实模型与浏览器成功路径验收（本地发布版 1cc80bd；人工确认正确触发，成功落库已核对）
- [x] P1 收尾：基线、7 组轨迹对照、完整 CI、当前服务健康与阶段边界已核验
- [x] P2 设计交付：原生工具协议、无语义索引阅读、引用迁移与缓存验收范围已成文
- [x] P2 正式实施：工具协议、参数校验、结果回传与自主文档阅读
- [x] P2 工程检查：逐调用轨迹、终止规则、稳定来源引用及故障回归
- [x] P2 本地部署：兼容迁移、真实合成问答、引用保存/恢复/定位、RLS 与临时数据清理
- [x] 用户确认 DeepSeek V4.1 Flash 为默认模型，界面及服务端默认请求已验证
- [ ] P2 真实论文人工验收及相对旧路径的质量、费用和耗时对照
