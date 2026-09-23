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
本仓库锁定的 `@supabase/supabase-js@2.49.8` 早于新格式；本机实测**用两种格式构造客户端都不报错**，
但没有对真实项目做过往返验证。若出现鉴权异常，先回退到旧的 `anon` / `service_role` 两个 JWT 键。
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

进入前端问答后，按 [执行内核说明](qa-agent-runtime.md) 的分流图先确认问题类型：

- 问"总结这篇论文"→ 走长上下文路径，**看不到 `tool_call`**，这是预期。
- 问一个具体事实 → 进入执行循环，SSE 依次出现 `agent_step`(plan) → `gap_check` → `tool_call` → `observation` → … → `agent_step`(answer_outline)。
- 服务端日志里 `[query-router]` 打出了分类原始返回，`[qa-stream] questionType =` 打出了最终分流结果，两者对照可以看清决策过程。

## 待办清单

- [x] `.env.qa.local` 建立并避让端口冲突（本机已验证）
- [x] 无凭据启动、健康检查、路由隔离（本机已验证）
- [ ] 新建独立 Supabase 测试项目
- [ ] 测试项目执行 `supabase/schema.sql`（含两个钩子函数，但先不启用钩子）
- [ ] 取 Project URL / anon / service_role 三个凭据填入 `.env.qa.local`
- [ ] 建测试账号（Dashboard → Users → Add user，或关掉 Confirm email 后注册）
- [ ] 指向同一测试项目启动三个进程：主应用 8790、QA 8789、前端 `--mode qa`
- [ ] 完成一篇论文的 MathPix 解析并请求建索引
- [ ] 跑通一次真实问答，确认 SSE 与落库
- [ ] 分别验证 `detail` 与 `global` 两条路径的实际事件差异
