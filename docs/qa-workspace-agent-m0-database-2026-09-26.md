# M0 隔离数据库、查询计划与多语言基线

日期：2026-09-26。状态：**已测定的 M0 设计基线；不是 M1 功能交付或生产数据库验收。**

脚本：[benchmark-qa-m0-database.mjs](../scripts/benchmark-qa-m0-database.mjs)。原始结果：[qa-workspace-m0-database-baseline-2026-09-26.json](fixtures/qa-workspace-m0-database-baseline-2026-09-26.json)。业务 schema/runtime 父提交基线：`7113e0ad32488cff5a8259e63dee22865b85bfd9`。探针是本轮新增文件，其精确内容由 [freeze manifest](contracts/qa-workspace-m0.freeze.json) 的脚本 SHA-256 绑定；此父提交不包含新增探针。结果记录了实际时间、schema 摘录哈希、SQL/参数、完整 EXPLAIN ANALYZE/BUFFERS JSON 与字符/字节计量。

## 1. 测试环境与可靠边界

先只读检查本机：PostgreSQL 17.11 客户端存在；`/var/run/postgresql:5432` 和 `127.0.0.1:5432` 均无响应；已安装目录没有 `postgres/initdb`。本轮使用仓库已有 **PGlite 0.5.8，新建内存 PostgreSQL WASM 实例**。未读取 `.env`、连接开发/生产数据库或新增产品 migration。

引擎报告：`PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten, compiled by emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 3.1.74 (1092ec30a3fb1d46b1782ff1b4db5094d3d06ae5), 32-bit`。本机可见 24 CPU，未施加 2 CPU / 2 GiB cgroup；采样最大进程 RSS 约 **687.2 MiB**，包含 JS/WASM/PGlite。没有网络、PostgREST、持久磁盘、并发数据库客户端，结果不能换算为生产延迟、容量或驻留内存 SLA。

直接从 `supabase/schema.sql` 抽取 5 张文库表的原始定义、文库字段/FTS trigger、相关现有索引以及 `search_user_library_documents` 函数。未加载无关向量扩展或全部迁移链。合成 `auth.uid()` 与 SELECT owner RLS 用于两用户隔离；它验证这一访问语义，不替代完整 Supabase 认证链。QA 发现 SQL 另以 bypass-RLS `service_role` + 显式用户过滤运行；不能将 RLS 与 service-role 计划混写成相同路径。

所有计时先预热 3 次，再顺序运行 15 次；计时含嵌入式 SQL 执行与结果解码，不含 SET ROLE/事务准备或网络。p95 是这 15 次样本的顺序统计，样本量有限。

## 2. 固定数据和 oracle

- 小规模：A、B 各 35 篇，31 活动、2 归档、2 删除；每用户 live=33。两账号共用合成 fingerprint，但 UUID/所有权独立。A 执行查询并伪填 B userId 得 0 行。
- 集合：根含 1–10、子含 6–15；直接 10，联合 distinct 15。两个标签分别含 1–12、6–18；ANY=18、ALL=7。实际已有 RPC 确认是 ANY 标签、直接集合，不把设计 ALL/含子集合语义说成已接入。
- 31 活动文档：limit+1 能识别第一页 30/hasMore；keyset 次页 1；两页 ID 去重共 31。**此处验证文库列表 SQL，不声称会话 UI 或已部署线程 API 已改成新游标。**
- 大规模：A、B 各 10,000 篇；每 100 篇软删 1、每 10 篇归档 1（删除优先）；每用户 live=9,900、活动=9,000。标签按 3/5 整除分配，与独立 JS 计数 oracle 对比。
- 同时间戳每 5 条一组，深位置 keyset 与 offset=8,000 返回同样的 31 个 ID；固定数据可重跑。跨请求内容变化仍是 live-keyset，不保证静态快照。
- 共 **21 项 oracle 断言通过**；另有 4 组召回断言、16 组计时和计划。脚本包含 `😀中` 的 UTF-16=3/code point=2/UTF-8=7 断言，防止计量混用。

M0 keyset、ALL 标签、集合去重和临时 `m0_probe_user_opened_id` 索引只存在本次内存实例，**没有接入 Agent 适配器、服务路由或产品 migration**。

## 3. 查询耗时与索引观察

单位 ms，仅本地 PGlite 样本：

| 查询 | p50 | p95 |
| --- | ---: | ---: |
| 35 篇/用户，发现 31 行（RLS） | 0.954 | 1.020 |
| 10,000 篇/用户，QA 发现 11 行（service-role） | 11.845 | 12.248 |
| 实际文库 RPC，30 行 + total（RLS） | 62.155 | 67.842 |
| 精确 count（RLS） | 7.939 | 8.073 |
| 标签 ANY（M0 SQL） | 10.919 | 11.758 |
| 标签 ALL（M0 SQL） | 29.366 | 30.008 |
| 集合联合去重（M0 SQL） | 13.486 | 13.966 |
| ILIKE 子串（service-role） | 51.736 | 52.115 |
| 独立 FTS token（service-role 探针） | 2.687 | 2.908 |
| 深 offset=8000（RLS） | 19.967 | 21.865 |
| 相同位置 keyset / 现有索引（M0） | 1.267 | 1.751 |
| keyset / 临时候选索引（M0） | 1.193 | 1.378 |

实际 RPC 同时生成全量过滤计数和分页 JSON，开销不能与只取 11 张卡片的发现 SQL 等同。其外层 `EXPLAIN` 只显示标量函数 Result；为了避免伪称看到了函数内部计划，另保留了直接 SQL 的执行计划。

在 service-role 的独立 FTS token 探针中，计划使用 `user_documents_library_fts_idx`；当前 Agent 的 `ILIKE '%...%'` 子串匹配没有这个加速，计划仍过滤候选记录。authenticated RLS 下同一 FTS 探针的计划不同，原始 JSON 单列角色。因此不能因文库存在 GIN，就宣布所有中文/关键词查询都走它。

keyset 深页在现有索引上已明显少于深 offset；新增含 ID 的候选索引没有在这次小样本中呈现稳定尾延迟收益。M0 可冻结 **稳定 ID 排序 + live-keyset 语义**，M1 再根据目标数据库计划决定是否新增复合索引，不能以此直接迁移生产库。

## 4. 中文、英文与跨语言边界

固定语料有 2 篇中文 attention 相关、2 篇英文相关、2 篇无关；其余合成背景记录也不匹配。当前 Agent 的字面 SQL 与真实文库 RPC 返回集合一致。

| 检索 | 同语相关召回 | 双语相关总召回 | 精确率 |
| --- | ---: | ---: | ---: |
| 中文 `注意力` | 2/2 | 2/4 | 2/2 |
| 英文 `attention` | 2/2 | 2/4 | 2/2 |
| 中文词直接找英文目标 | 0/2 | 2/4（只命中中文） | 2/2 |
| 人工词表 `注意力` + `attention` 联合 | 4/4 | 4/4 | 4/4 |

另断言中文子串 `注意` 经字面匹配能命中 2 篇；英文 `attentions` 不自动变成 `attention`（0 命中）。这支持 **首期采用字面检索 + 明确关键词改写** 的方向，但双语改写完全是固定人工词表，不是模型自动翻译质量，也不是一般学术查询召回分数。没有 embedding/rerank 或全文扫描 PDF。

## 5. 能冻结的预算与不能宣称的结果

| 候选 | 本轮证据 | 推荐冻结方式 |
| --- | --- | --- |
| 卡片默认 10、最大 30；preview 300 UTF-16 | 10,000 文档中只返回 limit+1；30 张中英/emoji卡片实测 10,423 UTF-16、8,923 code point、25,663 UTF-8 bytes | 可冻结为协议硬上限；其他字段和 JSON 字节仍单独计量 |
| 轻量记录扫描 2,000、字符扫描 1,000,000 | SQL 的大库统计/过滤在数据库完成，不把全库正文搬入 Node | 冻结为应用层兜底扫描上限；达到时 coverage=partial，**精确数据库 COUNT 不受 2,000 记录截断** |
| 单读 14,000、run 96,000 UTF-16 | 沿用现有原文阅读预算；本轮卡片尺寸低于单读上限 | 保留共享返回上限；本轮没有证明所有适配器都能达标或测出最佳值 |
| 每用户缓存 2 MiB、进程 16 MiB、TTL 60 秒 | 仅按当前序列化卡片估算最多 81 / 653 份，不含 JS对象开销 | 可冻结为保守内存/寿命上限；实现必须按实际占用淘汰；**未实测命中、失效、淘汰或 TTL 收益** |
| 查询延迟 | 16 个本地计划和有限重复样本 | 记录基线，不设置生产 p95 SLA；部署同等数据库和 RLS/角色下再测 |

本轮没有把“用内存上限做除法”称为缓存性能验收；缓存正确性、版本隔离和容量应在 M1/M4 实际适配器中验证。附带 JSON 明确 `M0_accounting_probe_not_runtime_cache`。

## 6. 复现

```bash
QA_M0_SOURCE_SHA=$(git rev-parse HEAD) node scripts/benchmark-qa-m0-database.mjs
```

命令只写指定合成结果 JSON，数据库在 finally 中关闭。传入 SHA 是为兼容此沙箱禁止 Node 子进程读取 Git 的限制，不用于连接外部服务。任一 SQL/计数/召回/长度断言失败即非零退出，不输出 completed 成功文件。基线计时会随主机调度和引擎缓存波动；固定数据、结果 oracle 和查询语义应保持相同。
