# M0：旧 Agent 轨迹守卫的历史溯源与版本兼容冻结

日期：2026-09-26。核对起点：`codex/qa-workspace-m0`，`7113e0ad32488cff5a8259e63dee22865b85bfd9`。

本项已完成本地离线验证。修改范围是历史对照脚本、比较器、反例测试和本记录；业务运行时、应用/QA 版本、数据库和部署均未改变。这里的七场景覆盖旧 JSON 控制器/启发式执行器，不代替新版工作区 Agent、真实模型、数据隔离或浏览器验收。

## 1. 历史差异来自哪里

原基线仍为 `23ddc3b713b20b34edcceacdb0199da280c39ca0`，即原脚本的 `240a8fe^`。没有以当前 HEAD 替换基线。

| 历史节点 | 已核对的事实 |
| --- | --- |
| `240a8febd5cca7948f93e93db1bd25e6f17b2ed9` | 从单文件执行器拆出 `server/qa/agent/*` |
| `4fd53e2` | 引入七组拆分前后轨迹比较脚本 |
| `6eb8db4f6481844420feba2760083b2844353a9c` | `server/qa/agent/loop.mjs` 的 `answer_outline.payload` 新增 `stopReason` 与完整归一化 `action`；同一提交把 QA `0.1.1-alpha.1` 升至 `0.2.0-alpha.1` |
| 当前核对起点 `7113e0a` | 已包含 `6eb8db4`，旧 loop 此后未再修改；QA 已为 `0.5.1`，应用为 `0.3.1` |

溯源命令：

```bash
git show 6eb8db4 -- server/qa/agent/loop.mjs server/qa/package.json
git log --oneline -- server/qa/agent/loop.mjs
git merge-base --is-ancestor 6eb8db4 7113e0a
git diff 6eb8db4 7113e0a -- server/qa/agent/loop.mjs
```

原脚本如今有 4/7 场景不再逐字段相同，原因是上述已发布的可观测契约扩展。不能继续把当前树描述为“与拆分前完全相同”，也不需要为本轮补测试再次改业务版本。

同一历史提交还增加了控制器调用前后的取消检查；本七场景没有发出取消信号，不能用这些结果证明取消行为保持不变。

## 2. 冻结的精确兼容范围

默认模式使用 `qa-0.2.0-answer-outline-v1`，绑定原基线的完整 SHA，并固定七场景名称及顺序。不同基线只能显式使用 `--mode=strict`；新增场景或替换场景不会悄悄通过原守卫。

只允许以下新增值，所有旧字段继续精确比较：

| 场景 | outline 索引 | `stopReason` | `action` |
| --- | --- | --- | --- |
| `search-open-finish` | 7 | `model_finish` | `{"action":"finish_retrieval","answerOutline":"Explain with evidence.","evidenceIds":["C1"]}` |
| `direct-answer` | 1 | `direct_answer` | `{"action":"direct_answer","evidenceIds":[],"reason":"greeting","replyOutline":"Hello."}` |
| `carryover` | 1 | `model_finish` | `{"action":"finish_retrieval","evidenceIds":["C1"]}` |
| `budget` | 5 | `budget_stop` | 必须缺省；`null`、空对象或任意动作均失败 |
| `unknown-action` / `search-error` / `heuristic-empty` | 无兼容路径 | 不允许新增 | 不允许新增 |

每个允许场景的索引 `i` 仅适用于三条路径：

```text
$.result.agentSteps[i].payload
$.steps[i].payload
$.events[i].payload.step.payload
```

比较器先核验历史 `kind=answer_outline`、`id=step-i`、`stepIndex=i`、事件名 `agent_step` 和完整旧 payload。再从旧轨迹复制出唯一允许的新轨迹，补入表中固定值，最后与当前结果比较整棵对象树。

它不从当前结果推断允许值，也不全局删除 `stopReason` / `action`。原字段丢失、任意未知字段、错误动作/证据编号、路径移动、事件顺序变化，以及用户/文档/查询参数变化都会失败。三个轨迹副本必须全部一致满足契约。数组顺序、长度和字段“缺省/为 null”有区别；JSON 对象键的排列顺序不作为语义变化。

## 3. 运行方式和实际结果

历史重放需要完整 Git 历史及已安装的依赖。重建的是原提交整棵树，复用本地依赖；模型、检索和持久化均注入合成实现，不连接模型供应商或数据库。

```bash
# 默认：检查已发布扩展后的精确兼容性
npm run check:agent-equivalence

# 原历史精确比较；当前树预期退出码 1，保留真实差异
npm run check:agent-equivalence -- --mode=strict

# 有意比较另一个历史点时必须明确 strict，不更新冻结基线
npm run check:agent-equivalence -- --mode=strict --baseline=23ddc3b

# 不依赖 Git 历史的比较器反例测试 + 原执行器回归
node --test tests/qa/qaEquivalence.test.mjs tests/qa/agentRunner.test.mjs tests/qa/agentRuntime.test.mjs
```

| 检查 | 本次本地结果 | 解释 |
| --- | --- | --- |
| 默认 versioned 七场景 | 7/7 通过，退出码 0 | 3 场景完全一致；4 场景符合固定版本扩展 |
| strict 七场景 | 3 完全一致、4 有差异，退出码 1 | 共 21 处字段新增：前三场景各 6 处，budget 3 处；没有其他差异 |
| 比较器反例测试 | 24/24 通过 | 错值/缺字段/多字段/错路径/乱序/错误基线/丢场景均拒绝 |
| 加上旧 `agentRunner`、`agentRuntime` | 39/39 通过 | 保留执行器正常、预算、非法动作、检索失败与事件持久化回归 |

独立比较器测试随现有 `npm test` 的 `tests/*/*.test.mjs` 模式进入 CI。历史重放仍不加入浅克隆 CI；需要完整历史时单独运行。`docs/qa-agent-runtime.md` 对初次拆分“完全一致”的记录是当时结果；当前默认命令采用本记录的显式兼容模式，要复查原历史差异使用 `--mode=strict`。

当前受限环境曾拒绝 Node 内的 Git 子进程，旧脚本将其误报为“找不到基线”。本次在已授权的本地执行权限下完成重放；新脚本会区分 `EPERM/EACCES` 和真实 Git 修订查询失败，避免让执行权限问题被当作浅克隆。

## 4. 后续维护与回退

1. 保留本完整 SHA 和 strict 模式。默认通过报告必须注明“完全一致/版本兼容”的数量。
2. 未知变化先修复或单独审阅。确属新公开契约时，以独立提交说明版本与历史出处，新增具名兼容版本和拒绝错误值的测试；不得递归忽略字段或切换到 HEAD 洗掉差异。
3. M1–M6 的新增工作区能力另设固定评测场景；不以旧七场景通过宣称这些能力已经实现或验收。
4. 本变更不改变业务行为。回退这三个脚本/测试文件及本文即可恢复旧验证工具；不需要业务数据迁移或服务回滚。
