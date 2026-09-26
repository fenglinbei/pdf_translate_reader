# M0 固定评测集与基线记录

日期：2026-09-26。状态：**M0 基线已补齐并冻结；第 1–3 节保留首次候选测量事实，第 4 节记录收尾。新能力与生产性能验收未执行。** 本文配合[升级计划](qa-workspace-agent-upgrade-plan-2026-09-26.md)，不改变产品功能、数据库、版本或服务配置。

## 1. 首次候选交付与结论（历史快照）

- 固定业务评测集：[qa-workspace-m0-cases.json](fixtures/qa-workspace-m0-cases.json)，版本 `qa-workspace-m0-cases-v1`，38 个合成案例。案例覆盖 M1–M7，均明确标记 `executionStatus: not_executed`。
- 本次现有回归：标准命令 `npm run test:qa` 在允许本地子进程通信的执行环境完成，29 个 QA 测试文件、**197 条测试通过，0 失败、0 跳过**，耗时 **4.714 秒**。此前逐文件替代运行也为 197 / 197。测试使用模型/HTTP mock 与内存 PGlite；不是线上请求或浏览器人工验收。
- 历史轨迹比较：复用已有 7 个合成场景，**3 个一致、4 个存在既有差异**。这是初次严格比较结果；后续版本兼容守卫见第 4 节。
- 脱敏机器可读结果：[qa-workspace-m0-baseline-results-2026-09-26.json](fixtures/qa-workspace-m0-baseline-results-2026-09-26.json)，含每文件测试数、耗时、TAP 摘要哈希与轨迹差异字段路径。原始日志保留在本机临时目录，不包含在正式交付内。

被测源码 HEAD 为 `fc091e69c0343f77743c7296f4a441030849606a`；Node `v24.19.0`、npm `11.17.0`、Linux。首次候选交付只增加文档与合成样本；原计划中的生产 SHA 与线上版本仍是历史发布记录，本轮没有刷新生产状态。

## 2. 固定数据与精确口径

评测对象都是手工构造的业务数据，不含真实账户、文献正文或日志。它们是未来 runner 的输入和 oracle，不是已接入工具的 API 请求。

| 数据 | 固定构成与 oracle |
| --- | --- |
| 两个用户 | `user-a`、`user-b`；同名文章、同 PDF fingerprint 不授予跨用户访问 |
| A 的 35 篇云端文章 | 未归档 31、归档 2、删除 2；可用合计 33；B 另有 1 篇文章，所有 A 的列表/计数都排除它 |
| 层级集合 | 根集合直接含 01–10 共 10 篇；子集合含 06–15；包含子集合按文档去重为 15 篇 |
| 两个标签 | mechanism 为 01–12，reading 为 06–18；ANY = 18，ALL = 7 |
| 会话 | A 有 31 个活动会话、1 个归档、1 个删除；B 有独立会话。第一页 30，下一页 1，删除与归档互不混淆 |
| 标题版本 | A01 是手动名 revision 2，A02 是 legacy；在途任务遇到改名 revision 3 后不得写入 |
| 长会话 | A03 含 16 条消息，最早约束为“仅比较实验设定，不评价疗效”；摘要必须能回溯其来源 |
| 本地文章 | 一个云端缓存副本、两个明确归属的独有 PDF；与云端合并的未归档文档去重为 33 |
| 本地资源 | PDF、页文本、MathPix 页面、划词译文、自由翻译历史/草稿、未同步批注/术语、会话草稿和即时环境逐类列出；无归属遗留数据保持不可查询 |
| 来源 | 个人笔记、原文高亮、确认/建议术语、译文、旧模型回答、PDF.js/MathPix/本地选文分别标识，不相互升级为原文证据 |

本次另以离线断言核对了用户范围、归档删除计数、标签交并、集合去重、会话分页数量、38 个案例状态及源码基线，全部一致；这仅验证评测样本自身的 oracle，不代表目标功能通过。

文件中的 `currentSupport` 含义：`existing_regression` 表示现有测试覆盖相近的既有能力，`partial` 表示仅部分基础有覆盖，`planned` 表示目标能力待实施。这些标签都不能替代本文件案例的执行结果。现已有 `npm run check:qa-m0` 复核这些数据和契约形状，但不是目标能力集成评测器；M1 起应为每批案例接入真实适配器、校验精确输出、存放脱敏轨迹。

## 3. 现有离线测试的实测边界

| 既有检查 | 本次结果 | 能证明的范围 |
| --- | --- | --- |
| QA 测试全集 | 197 / 197 通过 | 当前工具预算、来源范围、引用修复/持久化、取消、流输出、内存数据库约束等回归成立 |
| 10 用户合成准入 | 通过 | 最多 2 个活动任务、8 个排队任务，10 个任务完成；重复用户、取消、超时释放正常 |
| 普通问答 | 通过现有测试 | 当前主模型 1 次调用、0 工具/原文读取；未来标题辅助调用必须另计 |
| 来源范围与身份 | 通过现有测试 | 未返回范围不得引用、版本和身份绑定、无效来源不被接受；不证明引文语义支持结论 |
| 35 个合法引用 | 通过现有测试 | 当前有效引用不会因超过旧阈值 32 而误报；当前统一容量 128 仍受限 |
| 慢 SSE / 保存故障 | 通过现有测试 | 背压顺序、缓冲限制、保存失败不发成功结束；不等于 M6 崩溃恢复已完成 |
| 旧 runner 轨迹比较 | 3 一致 / 4 差异 | 默认历史基线需要解释和维护，不作为新工作区能力通过证据 |

逐文件串行测试耗时 **18.89 秒**；GNU time 报告最大 RSS **1,162,596 KiB**，包含 PGlite 和本地测试进程树。它不是 QA 服务常驻内存，更不是 2 CPU / 2 GB 生产负载结论，不能据此制定线上延迟或容量 SLA。

沙箱中第一次 `node --test` 默认隔离执行只输出 29 个文件级结果，没有内部测试计数。为避免误读，正式记录使用**每文件一个 Node 进程、文件内关闭测试隔离**，得到 197 条实际测试结果；文件之间仍保持进程隔离，避免 mock 和环境修改串扰。

### 3.1 复现 QA 回归

在本工作树且依赖已安装时执行；不需要加载 `.env`、真实模型密钥或启动产品服务：

```bash
qa_status=0
for qa_test in tests/qa/*.test.mjs; do
  env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 \
    node --test --test-isolation=none --test-reporter=tap "$qa_test" || qa_status=1
done
exit "$qa_status"
```

此命令适用于本文 Node 24 环境。本次已补跑标准命令 `npm run test:qa`，解除沙箱对子进程通信/测试临时端口的限制后，结果为 197 条测试、8 个 suite 全部通过，退出码 0。判断通过时应检查实际内部测试数，不能仅看文件数。涉及 migration 的测试只操作新建的内存 PGlite，未向开发/生产数据库应用迁移。Vite 相关测试只加载模块并关闭实例，没有启动或接管产品前端/API。

### 3.2 历史轨迹差异与复现

既有脚本默认基线 `240a8fe^`，解析为 `23ddc3b713b20b34edcceacdb0199da280c39ca0`。沙箱中 `npm run check:agent-equivalence` 的 `spawnSync git` 被拒绝为 `EPERM`，并误表现为“baseline 不可达”；shell 中同一 Git 历史可读取。先通过 shell 提取该版本，然后直接调用已有 `tests/fixtures/qaAgentScenarios.mjs` 的 `runScenario` 比较同样的字段，没有修改测试或 runner。随后在允许本地子进程 Git 读取的执行环境补跑标准命令，实际退出码为 **1**，同样得到 **3 一致 / 4 差异**，确认它不是仅由沙箱造成的比较失败。

四个不一致场景为 `search-open-finish`、`direct-answer`、`carryover`、`budget`。七个场景的逐字段差异全部是现版本在 `result.agentSteps`、保存的 `steps`、输出的 `events` 中**新增 `payload.stopReason` / `payload.action`**；没有发现字段移除或其他值变化。当前源码已经存在这些扩展，本次没有修改它们。收尾已追溯其历史版本并添加固定兼容协议，详见第 4 节；原严格结果和历史基线没有覆盖。

可在 shell 允许读 Git 历史的环境复现以下替代比较（只写临时目录，复用已有依赖）：

```bash
qa_baseline_dir=$(mktemp -d /tmp/qa-m0-legacy.XXXXXX)
git archive --format=tar --output="$qa_baseline_dir/source.tar" \
  23ddc3b713b20b34edcceacdb0199da280c39ca0
tar -xf "$qa_baseline_dir/source.tar" -C "$qa_baseline_dir"
ln -s "$PWD/node_modules" "$qa_baseline_dir/node_modules"
QA_M0_BASELINE_DIR="$qa_baseline_dir" node --input-type=module <<'NODE'
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runScenario, scenarioNames } from './tests/fixtures/qaAgentScenarios.mjs';
import * as current from './server/qa/agentRunner.mjs';
const previous = await import(pathToFileURL(
  `${process.env.QA_M0_BASELINE_DIR}/server/qa/agentRunner.mjs`).href);
let failed = 0;
for (const name of scenarioNames) {
  const before = await runScenario(name, previous);
  const after = await runScenario(name, current);
  const fields = Object.keys(before).filter(k => !isDeepStrictEqual(before[k], after[k]));
  if (fields.length) failed += 1;
  console.log(name, fields.length ? `DIFF: ${fields.join(', ')}` : 'MATCH');
}
process.exitCode = failed ? 1 : 0;
NODE
```

预期返回非零并列出 4 个差异，不能把这个预期解释成“等价通过”。该脚本守卫的是旧 `agentRunner` 提取行为，不覆盖本轮完整 `workspace-artifacts-v1` 或将来的跨资源访问质量。

## 4. M0 收尾与测量索引

以下记录补齐原候选中的当前路径测量与协议限额，使用不同证据分别回答不同问题：

| 项目 | 已完成的证据 | 不能据此宣称 |
| --- | --- | --- |
| 首字、总耗时、队列、取消、缓存、扫描、RSS | [真实 2 CPU / 2 GiB 隔离运行](qa-workspace-agent-m0-runtime-2026-09-26.md)，三独立进程，9 场景 / 1,230 请求；真实 loopback HTTP/SSE | 供应商回答耗时、完整认证 API 或生产吞吐 SLA |
| 查询、计数、分页、角色与数据库计划 | [内存 PostgreSQL/PGlite](qa-workspace-agent-m0-database-2026-09-26.md)，原 schema/RPC 与 M0 SQL 分别记录，21 oracle / 16 查询组 | 已迁移线上 SQL、真实 Supabase 网络/RLS 性能、新会话分页已接入 |
| 中英与跨语召回 | 4 组真实词法 SQL 断言；单语覆盖 2/4 双语目标、人工双语词表 4/4 | 通用学术检索质量、模型关键词改写质量 |
| 标题 tokens、耗时与费用 | [16 次真实短请求](qa-workspace-agent-m0-titles-2026-09-26.md)，已知 usage 16/16；14 规则通过 / 2 语言失败，失败样本不丢弃 | M2 队列/CAS 已实现、所有长度和语言的标题质量已通过 |
| 历史轨迹守卫 | [精确版本兼容](qa-workspace-agent-m0-equivalence-2026-09-26.md) 7/7；严格对照仍 4/7 有差异；24 个反例测试 | 删除原差异、旧执行器证明了新版跨资源能力 |
| Schema/固定数据 | `npm run check:qa-m0`：45 结构样本、38 案例、计数/归属/UTF-16 预算 oracle | 38 个未来案例已实际执行 |
| 原型交互 | [浏览器记录](fixtures/qa-workspace-m0-visual-review-2026-09-26.json)，用户已确认当前版 | 真实 PDF 坐标、跨标签页 CAS、产品持久化人工验收 |

冻结设计范围与上限见 [协议](qa-workspace-agent-m0-contracts-2026-09-26.md)及[冻结清单](contracts/qa-workspace-m0.freeze.json)。首次结果 JSON 仍保留当时 fixture 的 SHA，当前冻结文件的 SHA 由新清单记录；不是把旧测量重新归属到新文件。

尚未实现的通用缓存/适配器、标题任务调度、选文附件、客户端通道、M5 摘要质量/费用与 M6 恢复，继续由各自里程碑实际实现后验证。M0 完成的是当前路径基线、设计限额、固定样本与回归口径；不以新功能尚未实现为理由填造测量，也不把它们误标为通过。全量 CI 与最终文件证据见 [M0 完成记录](qa-workspace-agent-m0-closeout-2026-09-26.md)。
