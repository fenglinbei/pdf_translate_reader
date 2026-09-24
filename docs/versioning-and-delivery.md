# 版本、CI/CD 与 QA 隔离规范

2026-09-25：[工作区 UI 候选](qa-workspace-ui-review.md) 的代码版本为应用 `0.2.0-alpha.1` / QA `0.4.0-alpha.4`，已完成本地检查。用户要求先讨论流转，现有 5174 / 8789 验收入口仍保留上一版。

状态：仓库实现；生产切流与部署另行验收。本文是后续开发与发布的约束。

2026-09-24：[P1 已收尾](qa-agent-stage-1-closeout.md)，[P2 已实现并完成本地部署](qa-agent-stage-2-implementation.md)。此前 [会话升级](qa-conversation-upgrade-2026-09-24.md) 已将 QA 版本升为 `0.3.0-alpha.3` 并完成本地部署，支持自动判断普通/文档问题，默认使用 DeepSeek V4.1 Flash。当前 [工作区升级](qa-workspace-agent-plan.md) 为 `0.4.0-alpha.3`，已完成本地隔离部署及工程自动验收，用户人工验收待进行。
部署顺序为：独立测试库兼容迁移 → 兼容前端 → QA 制品 → 显式开启 `document-tools-v1`；生产继续保持既有发布。

工作区升级使用 `workspace-tools-v1`，必须先备份并应用 `20260925_qa_workspace.sql`；详细行为与回退限制见 [工作区问答契约](qa-workspace-agent-plan.md)。

## 版本规则

采用 [SemVer 2.0.0](https://semver.org/)。应用和独立 QA 服务分开发布：

| 对象 | 唯一版本来源 | Git 标签 | 当前开发版本 |
| --- | --- | --- | --- |
| 应用（阅读器、翻译、文库） | 根 `package.json`，同步 lockfile | `vX.Y.Z` | `0.1.0`，沿用已有声明，不追认历史正式发布 |
| QA 服务 | `server/qa/package.json` | `qa-vX.Y.Z[-alpha.N/-beta.N/-rc.N]` | `0.4.0-alpha.3` |
| 检索、提示词、索引协议 | `server/qa/config.mjs` | 随服务发布 | 首次拆分保持原值 |

公共兼容面包含 HTTP 请求、SSE 事件、持久化数据和配置；内部重排不应改变它们。
0.x 阶段：兼容修复/内部重构递增 patch；功能或不兼容变化递增 minor，并单独说明迁移。
1.x 起：破坏兼容递增 major，兼容功能递增 minor，修复递增 patch。
预发布号只用于开发/测试；生产拒绝带后缀的版本。正式标签不得移动或复用。
每个制品还必须携带完整源码 SHA 和 SHA-256 校验文件，版本号不能代替源码身份。
修改 chunker/embedding 协议才评估重建索引；单纯拆分执行器不能触发全量重建。

## 开发与集成

1. 从确认的最新基线建立 `codex/<主题>` 分支，小步提交；已有未提交文件不混入提交。
2. PR 和所有分支 push 均运行名为 `quality` 的 CI。`main` 应要求 PR、该检查通过、禁止强推和删除。
3. CI 使用 `.nvmrc`、`npm ci`，执行版本检查、全项目测试、TypeScript 和前端构建；无生产凭据。
4. QA 重构保持原 API 和事件契约，新增正常/失败轨迹测试；翻译、文库、MathPix、模型测试属于必过回归。
5. `main` 当前落后于已使用的功能分支。先通过评审整合基线，再启用默认分支上的手动发布入口，不能用旧 `main` 覆盖现有功能。
6. `workflow_dispatch` 入口需要工作流先进入默认分支。功能分支 CI 通过不代表 CD 已可用。

首次核查（2026-09-23）：仓库尚未设置 `main` 保护，也没有 GitHub Environments。
本轮提交工作流和发布脚本，未代为修改仓库管理策略或接入部署密钥；上面的分支保护与下面的环境配置是启用发布前的待办。

## QA 开发环境

逐步操作见 [QA 开发环境：跑通一次真实问答](qa-dev-setup.md)。

复制 `.env.qa.example` 为 `.env.qa.local`，填写独立 Supabase 测试项目及测试账号。
`QA_ENV_FILE=.env.qa.local npm run dev:qa` 启动 loopback QA API，默认端口 8788；
该端口可能与机器上的其他服务冲突，启动前先确认空闲，冲突时改 `QA_PORT`。
它不加载 `.env` / `.env.local`，不启动文库元数据 worker，默认不恢复索引任务。
测试索引需要显式请求；`QA_INDEX_WORKER_ENABLED=true` 只控制启动时的恢复，不是禁写开关。
开发凭据和真实生产数据必须隔离；模型额度也宜分开设置，避免共享额度耗尽影响翻译。

开发前端设置 `VITE_QA_API_PROXY_TARGET=http://127.0.0.1:8788`，只有 `/api/qa/` 转到测试服务。
这个开关只适用于 Vite 开发代理；测试项目需要匹配的前端登录会话。
生产测试使用独立测试入口与测试账号，不把生产登录 token 发到另一 Supabase 项目。
任何开发流程均不自动部署主应用、不自动迁移生产数据库。

## 发布流程

1. 更新 QA 版本与 `docs/qa-changelog.md`，CI 通过后为确切提交打 `qa-v...` 标签。
2. 标签触发 `QA release`：重新检查并打包。制品仅包含运行代码/依赖清单；不包含前端、环境文件、PDF 或工作区文件。
3. 手动触发同一工作流，指定 tag、完整 SHA 和 `qa-staging` / `qa-production`。
4. GitHub Environment 完成配置并启用 `QA_CD_ENABLED=true` 后，发布任务才允许连接独立 QA 服务；生产要求稳定版。
5. 发布到独立版本目录，安装该版本依赖，原子切换 QA 的 `current`，只重启 QA 单元。
6. 检查 `/api/qa/health` 的服务名和 SHA；失败恢复上一个版本。健康只证明进程与版本，不能替代登录、检索和引用验收。
7. staging 要人工验收一次真实问答与错误处理，然后才能安排 production 发布。

环境与并发控制依据 [GitHub Actions 官方文档](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)。
环境需要 required reviewer、受限发布 ref，以及串行部署。写了 environment 字段不代表保护规则已经启用。

每个 GitHub Environment 配置：

- Secrets：`QA_DEPLOY_HOST`、`QA_DEPLOY_USER`、`QA_DEPLOY_KEY`、`QA_KNOWN_HOSTS`（人工核验的 SSH 主机公钥）。
- Variables：`QA_CD_ENABLED`、`QA_DEPLOY_ROOT`、`QA_PORT`。
- 部署账号仅可管理对应 QA 服务；权限不包含主应用服务、Nginx 配置和数据库迁移。

## 一次性隔离部署准备

部署前由运维选择独立 `QA_DEPLOY_ROOT`，在该目录创建 `.qa-deploy-root`，内容为服务名。
允许的单元名固定为 `pdf-reader-qa-staging.service` 与 `pdf-reader-qa.service`。
QA 使用独立 `releases/`、`current`、`qa.env`；该根目录不可是主应用目录。
Node 版本与 `.nvmrc` 一致。配置 systemd 的 WorkingDirectory 为 QA 根目录，
ExecStart 为 `node <QA_DEPLOY_ROOT>/current/server/qa-service.mjs`，
Environment 指定 `QA_ENV_FILE=<QA_DEPLOY_ROOT>/qa.env`。
按机器余量配置 MemoryMax、CPUQuota、TasksMax 与请求并发/供应商额度，避免独立进程争用拖慢主应用。

第一次切流需要单独安排：先验证独立 QA，Nginx 添加更具体的 `/api/qa/` location，指向 QA 端口，关闭 buffering，保留 Authorization 并设置足够流式超时；其余 `/api/` 原样保留。
主应用设置 `QA_EMBEDDED_ENABLED=false`，停用其 QA 路由和索引恢复，避免两个索引 worker 同时运行。
该首次配置切换可能涉及主服务重启，必须安排维护窗口；之后日常 QA 发布只动 QA 服务。
本轮没有执行这次生产切换，也不声称已实现线上进程隔离或零停机。

## 回滚与数据边界

自动回滚只覆盖重启/健康失败；业务验收失败时由部署账号把 `current` 原子切回已验证的版本目录，再重启同一个 QA 服务并核对健康 SHA。
保留旧 release 和其依赖；禁止现场 `git pull` 覆盖正在运行的目录。
P2 包含增量迁移 `supabase/migrations/20260924_qa_document_tools.sql`，先备份再应用到独立测试库；保留 chunk 引用与旧运行制品。关闭新执行器或回退代码不删除新引用字段；代码回滚不等于数据回滚。
`0.3.0-alpha.1` 起另外需要 `supabase/migrations/20260924_qa_conversation.sql`，扩展会话 scope 和步骤 kind 约束，不修改已有记录。回退到 0.2.x 后无文档普通问答不可用，新会话仍保留；不要缩回约束或删除 general/commentary 数据。
原 `deploy-linux-nginx.sh` 仍是整站部署入口，只能用于明确授权的应用发布，QA CD 不调用它。

## 交付状态必须分开

记录“代码已实现 / 本地检查通过 / 远程 CI 通过 / CD 已配置 / staging 已验收 / 生产已部署”。
仓库配置、GitHub 保护规则、服务器初始化和线上验收需要各自证据，不能互相替代。
