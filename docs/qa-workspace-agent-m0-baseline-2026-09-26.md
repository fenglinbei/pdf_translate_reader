# M0 固定评测集与离线基线候选

日期：2026-09-26。状态：**基线候选已实测；新能力验收未执行，生产性能及辅助模型预算尚未冻结。** 本文配合[升级计划](qa-workspace-agent-upgrade-plan-2026-09-26.md)，不改变产品功能、数据库、版本或服务配置。

## 1. 本次交付与结论

- 固定业务评测集：[qa-workspace-m0-cases.json](fixtures/qa-workspace-m0-cases.json)，版本 `qa-workspace-m0-cases-v1`，38 个合成案例。案例覆盖 M1–M7，均明确标记 `executionStatus: not_executed`。
- 本次现有回归：标准命令 `npm run test:qa` 在允许本地子进程通信的执行环境完成，29 个 QA 测试文件、**197 条测试通过，0 失败、0 跳过**，耗时 **4.714 秒**。此前逐文件替代运行也为 197 / 197。测试使用模型/HTTP mock 与内存 PGlite；不是线上请求或浏览器人工验收。
- 历史轨迹比较：复用已有 7 个合成场景，**3 个一致、4 个存在既有差异**。不得将 `check:agent-equivalence` 报为通过。
- 脱敏机器可读结果：[qa-workspace-m0-baseline-results-2026-09-26.json](fixtures/qa-workspace-m0-baseline-results-2026-09-26.json)，含每文件测试数、耗时、TAP 摘要哈希与轨迹差异字段路径。原始日志保留在本机临时目录，不包含在正式交付内。

被测源码 HEAD 为 `fc091e69c0343f77743c7296f4a441030849606a`；Node `v24.19.0`、npm `11.17.0`、Linux。本次只增加文档与合成样本；原计划中的生产 SHA 与线上版本仍是历史发布记录，本轮没有刷新生产状态。

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

文件中的 `currentSupport` 含义：`existing_regression` 表示现有测试覆盖相近的既有能力，`partial` 表示仅部分基础有覆盖，`planned` 表示目标能力待实施。这些标签都不能替代本文件案例的执行结果。新增 JSON 未伪装成可直接执行的评测器；M1 起应为每批案例接入真实适配器、校验精确输出、存放脱敏轨迹。

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

四个不一致场景为 `search-open-finish`、`direct-answer`、`carryover`、`budget`。七个场景的逐字段差异全部是现版本在 `result.agentSteps`、保存的 `steps`、输出的 `events` 中**新增 `payload.stopReason` / `payload.action`**；没有发现字段移除或其他值变化。当前源码已经存在这些扩展，本次没有修改它们。冻结前应明确这些历史轨迹扩展是否是已接受的兼容变化，再按维护流程调整旧守卫；不能为了绿色结果自动覆盖基线。

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

## 4. M0 尚未测定的项目与完成方式

以下缺口保持 `not_measured`；它们不能由本地单元测试耗时代替。

| 项目 | 本次状态 | 冻结前的具体取证 |
| --- | --- | --- |
| 首字/总耗时及尾延迟 | 未测线上或隔离端到端请求 | 独立 QA 测试实例，固定 mock 模型先采 p50/p95；之后另列真实供应商耗时 |
| 查询耗时与数据库计划 | 未运行真实数据库 EXPLAIN | 在隔离测试库载入大于一页的固定数据，核对用户筛选、去重计数、游标和索引；保存脱敏 EXPLAIN/ANALYZE |
| 缓存读写量和扫描预算 | 新资源适配器尚未实现 | 记录命中率、返回字符/字节、扫描条目、去重与版本失效，再冻结上限 |
| 2 CPU / 2 GB 运行内存和队列 | 仅合成准入策略通过 | 与部署相同限制的独立实例测 RSS/队列峰值、取消回收和前台/辅助任务公平性 |
| 标题 token / 超时 / 成本 | 标题辅助任务尚未实现且未调用模型 | 固定短问题/回答样本，先 mock 验证调用与故障行为，再在明确费用范围内测定真实模型预算 |
| 摘要成本和质量 | M5 尚未实现 | 与标题分开记录；用长会话与更正/删改/撤权样本验收来源依赖和预算 |
| 中文、英文、跨语召回 | 仅固定了 oracle，未跑真实新适配器 | 分别记录目标召回和错误来源，不能合成一个掩盖中文失效的总分 |
| 38 个目标案例与浏览器流程 | 输入/预期已保存，未执行新能力 | M1–M7 按依赖逐批转为可执行验证；桌面/窄屏/键盘仍需真实浏览器与人工评审 |
| 旧轨迹基线差异 | 已精确定位，尚未维护比较守卫 | 确认已接受的新增轨迹字段后维护基线/版本说明，再重跑守卫 |

建议将当前材料作为**M0 冻结候选 v1**审阅：范围、数据、操作契约、视觉稿和验收口径先明确，量化预算保留待测字段。若坚持原计划中“M0 测定”这一出口，以上生产等效/辅助模型样本和旧轨迹守卫问题仍应完成后才将 M0 总体标记为完成。没有因此启用新能力、增加遥测、收费调用或隐式后台研究任务。
