# QA 开发环境：跑通一次真实问答

状态（2026-09-23 更新）：已完成两轮本地真实问答并核对落库；Agent 路径已跑通，长上下文成功路径尚未通过验收。
具体结果、证据范围和待修复问题见 [两轮真实运行核验](qa-local-runs-2026-09-23.md)，文末清单已同步。
规范约束见 [版本、CI/CD 与 QA 隔离规范](versioning-and-delivery.md)，本文只是操作步骤。

离线学习（`npm run demo:qa`）不需要本文任何一步。需要看真实检索、真实模型决策和真实 SSE 时才需要。

## 启动流程

一次性准备只做一次；之后日常就是"三个终端 + 验收"。

### 一次性准备

1. 建独立 Supabase 测试项目、执行 `supabase/schema.sql`、建测试账号 → 见 [建立独立的 Supabase 测试项目](#建立独立的-supabase-测试项目)。
2. 填 `.env.qa.local` 并跑 `npm run check:qa-env` 确认通过 → 见 [配置文件](#配置文件)。
3. 在测试项目里完成一篇论文的 MathPix 解析 → 见 [建索引](#建索引循环能不能跑起来的前提)。

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
- `embedding.configured` 必须是 `true`，否则 QA 检索会退化成纯文本检索。
- `curl -s localhost:8790/api/qa/threads` 应返回 `503 qa_disabled`，证明内嵌 QA 已按预期关闭。

**终端 2 — QA 服务（8789）**

```bash
cd /home/fenglin/project/pdf_translate_reader
QA_ENV_FILE=.env.qa.local npm run dev:qa
```

验证：`curl -s localhost:8789/api/qa/health`

**终端 3 — 前端（5173，`--mode qa`）**

```bash
cd /home/fenglin/project/pdf_translate_reader
npm run dev:web -- --mode qa
```

`--mode qa` 让 Vite 加载 `.env.qa.local` 并**覆盖** `.env.local`；不加这个参数前端会继续连生产项目。
本机已实测：`mode=qa` 命中 `.env.qa.local`，默认 `development` 模式不受影响。

⚠️ **如果你已经有一个开发前端在跑，5173 会被占用，Vite 不会报错，而是静默改用 5174。**
本机实测：启动时提示 `Port 5173 is in use, trying another one...` 然后监听 5174。
两个前端长得一模一样，但一个连生产项目、一个连测试项目——**开错窗口会在生产项目里登录**，
然后看到一堆莫名其妙的 401。启动后务必确认日志里的端口，并按那个端口打开。

### 验收顺序

1. **三个健康检查**：`localhost:8789/api/qa/health`、`localhost:8790/api/health`、`localhost:5173` 都能打开。
2. **确认前端连的是测试项目**：浏览器登录测试账号。若此时翻译/文库报 401，就是终端 1 或终端 3 没指向测试项目。
3. **建索引**：`POST localhost:8789/api/qa/index-jobs`，等状态到完成。
4. **提一个具体事实问题** → 看到 `agent_step`(plan) → `gap_check` → `tool_call` → `observation` → … → `agent_step`(answer_outline)。
5. **提"总结这篇论文"** → 走长上下文路径，看不到 `tool_call`，这是预期。

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

## 配置文件

一个 `.env.qa.local` 同时喂三个进程：QA 服务直接用（`QA_ENV_FILE`），主应用用 `--env-file`，
前端用 `--mode qa`（[已验证](#每个终端各起一个进程)）。它被 `.gitignore` 的 `.env.*.local` 覆盖，不会进版本库。

需要填的值：

```bash
QA_ENVIRONMENT=development
QA_PORT=8789                  # 必须避开本机已被占用的 8788
QA_INDEX_WORKER_ENABLED=false # 保持 false：只控制启动恢复，不打开就不会认领别人的任务
SUPABASE_URL=https://<测试项目>.supabase.co
SUPABASE_ANON_KEY=<测试 anon>
SUPABASE_SERVICE_ROLE_KEY=<测试 service_role>
DEEPSEEK_API_KEY=<建议用独立额度>
VOYAGE_API_KEY=<建议用独立额度>

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
| 7 个凭据都已填 | `--env-file` 会注入空值并遮蔽 `.env.local`，空着不会自动回落 |
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

`DEEPSEEK_API_KEY` 与 `VOYAGE_API_KEY` 决定控制器调用与语义检索，缺失时表现为控制器调用失败、
或退化为纯文本检索；模型额度建议与生产分开，避免共享额度被翻译任务耗尽。
`MATHPIX_APP_ID` / `MATHPIX_APP_KEY` 是索引的上游，缺失时无法建索引。

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

前端配置见上一节"整条栈必须指向同一个测试项目"，要点是 `VITE_QA_API_PROXY_TARGET` 只影响
`vite.config.ts` 里 `/api/qa/` 这一条代理规则，**不解决登录**；登录由 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
决定，且必须与 QA 服务校验 token 用的项目一致。

联调时主应用建议设 `QA_EMBEDDED_ENABLED=false`，避免两个索引 worker 同时运行。

## 观察点

两条路径的完整逻辑图见 [一次 QA 请求的逻辑图](qa-request-flow.md)。

进入前端问答后，按 [执行内核说明](qa-agent-runtime.md) 的分流图先确认问题类型：

- 问"总结这篇论文"→ 走长上下文路径，**看不到 `tool_call`**，这是预期。
- 问一个具体事实 → 进入执行循环，SSE 依次出现 `agent_step`(plan) → `gap_check` → `tool_call` → `observation` → … → `agent_step`(answer_outline)。
- 服务端日志里 `[query-router]` 打出了分类原始返回，`[qa-stream] questionType =` 打出了最终分流结果，两者对照可以看清决策过程。

## 想看清每次交互和工具参数：查库，不要靠界面

界面的「检索过程」面板只渲染 `summary` 和证据编号，**看不到工具入参和 payload**。完整数据都在数据库里：

| 想看什么 | 存在哪 |
| --- | --- |
| 每一步的类型、摘要、证据编号 | `user_qa_agent_steps` |
| **每一步的完整 payload** | `user_qa_agent_steps.payload`（jsonb） |
| **模型每轮的决定** | `gap_check` 步骤的 `payload->'action'`（归一化后的动作） |
| **工具调用的完整入参** | `user_qa_tool_calls.input`（jsonb） |
| **工具返回了什么证据** | `user_qa_tool_calls.result_evidence_ids` |
| 工具耗时、报错 | `user_qa_tool_calls.started_at/finished_at/error_message` |
| **证据正文（C 编号 → chunk）** | `user_qa_messages.retrieval_snapshot->'evidence'` |
| 引用校验结果 | `user_qa_citations` |

`scripts/qa-trace.sql` 把这七块一次性打出来（本机用合成数据验证过全部语句）：

```bash
# 最近一次问答
psql -p 5432 -d postgres -f scripts/qa-trace.sql

# 指定某次
psql -p 5432 -d postgres -v msg_id=<uuid> -f scripts/qa-trace.sql
```

连接参数沿用前面那套 `PGHOST` / `PGUSER` / `PGPASSWORD`。第 0 节会回显取到的消息，先确认目标对了再往下看。

其中第 2 节最贴近"模型每次交互"：`turn` 是循环第几轮，`model_action` 是模型选了哪个动作，`rewritten_query` 是**模型自己改写的检索词**（通常不等于你的原话）。

### 有一层是查不到的

**发给模型的消息**和**模型返回的原始文本**都不落库，这是有意为之（`qa-agent-runtime.md`：不新增模型私有推理文本的存储）。
`gap_check` 里存的只是**归一化之后**的动作。

所以要看到逐字的 prompt 和原始响应，需要另加一个调试开关——目前代码里没有任何 debug 设施。要的话得改
`agent/controller.mjs`，在 `complete()` 前后各打一行。

## 待办清单

- [x] `.env.qa.local` 建立并避让端口冲突（本机已验证）
- [x] 无凭据启动、健康检查、路由隔离（本机已验证）
- [x] 独立 Supabase 测试项目已配置（与主应用配置的项目不同）
- [x] 本轮所需 QA 表与数据可查询（不据此宣称完整 schema / 钩子配置全部验收）
- [x] 测试凭据已填入 `.env.qa.local`；前后端项目配置一致
- [x] 测试账号完成真实提问，消息、步骤、工具和引用已落库
- [x] 本地 QA 8789 与测试主应用 8790 健康检查通过，主应用内嵌 QA 已关闭
- [x] 论文 MathPix 解析来源的索引为 `ready`，真实使用语义检索与重排
- [x] 两轮真实问答均成功落库，Agent 搜索与 `open_chunk` 已执行
- [ ] 浏览器 / SSE 逐事件复验（本次未重放历史流，5173/5174 当前未响应）
- [ ] 长上下文成功路径验收（第二轮 global 尝试失败后回落 Agent，原因待追踪）
