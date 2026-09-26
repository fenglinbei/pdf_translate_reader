# M0：隔离 QA 运行与 HTTP/SSE 性能基线

日期：2026-09-26。状态：**已完成当前运行路径的隔离合成测量与回归阈值冻结。** 本文测量 `workspace-artifacts-v1` 的本地执行开销和独立 HTTP/SSE 边界，不代表供应商模型时延、真实数据库性能或生产接口完整验收。

被测业务 runtime 的父提交基线为 `7113e0ad32488cff5a8259e63dee22865b85bfd9`。探针脚本是该工作树本轮新增的未提交文件，不属于此 SHA；最终探针内容由结果中的 `scriptSha256` 单独标识。新增[基准脚本](../scripts/benchmark-qa-m0-runtime.mjs)与[机器可读结果](fixtures/qa-workspace-m0-runtime-baseline-2026-09-26.json)；没有修改业务 runtime、版本、服务配置或数据库。

## 1. 执行约束与真实调用路径

使用本机已有 `node:24.19.0-bookworm-slim` 镜像运行临时容器，未拉取镜像。每个进程运行于 `--network none --cpus 2 --memory 2g --memory-swap 2g --pids-limit 128`，非 root 用户，只读挂载 `scripts/server/shared/node_modules`，仅专用结果目录可写。没有挂载 `.env` 或产品数据。

脚本从容器内实际读取并断言：

| 证据 | 实测 |
| --- | --- |
| Node | v24.19.0 |
| `cpu.max` | `200000 100000`：每 100 ms 最多使用 200 ms CPU 时间，即 2 CPU 配额 |
| `memory.max` | `2147483648` 字节：2 GiB 硬上限 |
| `memory.swap.max` | `0` |
| `cpuset.cpus.effective` | `0-23`；未假称只绑定两颗 CPU，实际限制来自 CPU quota |
| 内存限额事件 | 三次进程的 `max/oom/oom_kill` 全部为 0 |

曾只读检查用户 systemd scope：内存限额有效，但父 `user.slice` 未委派 CPU 控制器，子 scope 没有 `cpu.max`。没有修改主机控制器或系统配置；正式测量全部改用上表的 Docker cgroup 限额。没有用 CPU affinity 或 V8 heap 上限冒充 2 CPU / 2 GiB 容器限制。

使用真实 `handleWorkspaceStream → createDocumentRunContext → runWorkspaceAgent → createArtifactProtocol/createArtifactWorkspace → createArtifactLoader → createSseWriter`。注入的是合成 DB/文档存储回调和确定性的原生工具模型适配器；模型按实际工具协议返回 `read_document/search_document` 和分段答案。只以 `setImmediate` 让出事件循环验证交错/取消，**没有插入 sleep 模型时延，没有真实模型请求**。

HTTP 场景使用容器内 `127.0.0.1` 临时端口：真正的 Node HTTP server 写 SSE，native fetch 客户端逐帧读取第一个非空答案 delta、`done` 与 body EOF。它绕过产品认证、外层产品路由、代理与 TLS，数据库仍为合成回调，因此是隔离传输探针，不是完整生产 API。

## 2. 数据、样本与计时口径

文档为 90 段合成英文，共 25,882 UTF-8 字节；版本化 manifest 33,258 字节、4 个分片，全部产物合计 111,546 字节。解析和打包在计时开始前完成，测量已准备文档的读取。没有真实用户数据。

执行 **3 个全新独立容器进程，每次 9 场景、410 个计时请求，合计 1,230 个**；另有每进程 35 个暖机请求，全部排除。单请求场景每次 30 样本；并发场景每次 10 批、每批 10 个不同用户。p50/p95 采用 nearest-rank；下面为三次独立运行各自分位数的中位数，不是将所有样本混合后的分位数。

普通 harness 的首字指真实 SSE writer 写出第一个非空答案 delta；总耗时到终态保存/清理结束。并发场景从请求提交开始计时，包含等待队列。HTTP 场景从 fetch 开始计时，首字取客户端读到答案 delta，总耗时取 `done` 之后 body EOF，结果另存服务端耗时。

| 场景 | 首字 p50 / p95（ms） | 总耗时 p50 / p95（ms） | 额外观察 |
| --- | --- | --- | --- |
| 普通问答 harness | 0.162 / 0.271 | 0.419 / 0.621 | 1 模型调用、0 工具、0 文档读 |
| 文档冷读 harness | 3.580 / 6.261 | 3.979 / 6.882 | 2 模型调用、1 工具、1 合法引用 |
| 同用户同版本热读 | 1.401 / 3.373 | 1.754 / 4.373 | backing store 读取 0 次/0 字节 |
| 文档词法搜索未命中 | 3.006 / 5.303 | 3.312 / 5.633 | 实际扫描 25,594 字符，返回原文 0 |
| 首个 delta 后取消 | 0.153 / 0.189 | 0.252 / 0.302 | 全部 aborted，提交答案 0 次 |
| 10 用户并发文档读 | 19.696 / 37.317 | 21.472 / 38.827 | 等待 p95 31.513 ms，活动峰值 2、排队峰值 8 |
| 10 用户中取消一个排队请求 | 16.995 / 32.573 | 19.584 / 33.432 | 表中时延仅计其余 9 个成功请求；被取消者模型调用 0 |
| HTTP 普通问答 | 1.720 / 2.146 | 2.412 / 2.978 | 客户端实际 HTTP/SSE 观察 |
| HTTP 文档冷读 | 4.761 / 7.388 | 5.699 / 8.411 | 客户端实际 HTTP/SSE 观察 |

上述毫秒数只表达当前固定合成样本的运行与传输开销，不能解释为上线后用户会在 3–8 ms 内得到模型回答。固定 mock token 数只用于走通 usage 保存，不可用于成本计算。

## 3. 缓存、扫描、持久化和内存

| 场景 | 文档存储读取次数 / UTF-8 字节 | loader hit / miss | 返回 / 扫描字符 | 缓存估算常驻字节 |
| --- | --- | --- | --- | --- |
| 普通问答 | 0 / 0 | 0 / 0 | 0 / 0 | 0 |
| 文档冷读 | 2 / 55,355 | 31 / 2 | 9,006 / 0 | 221,420 |
| 文档热读 | 0 / 0 | 33 / 0 | 9,006 / 0 | 221,420 |
| 未命中词法搜索 | 3 / 64,969 | 88 / 3 | 0 / 25,594 | 259,876 |

这些是实际 loader 指标和实际存储回调载入字节，字符计数沿用运行时 UTF-16 单元口径。缓存常驻量是当前 loader 的保守对象估算，不等于实测 JavaScript heap 字节。冷读定义为新建应用 loader，不宣称清空主机页缓存。热读共享同用户、同文档版本的 loader，三轮全部验证后端载入为零；授权检查仍执行。

普通回答的合成持久化回调写入 7 次，文档回答 11 次；完整结果保存写入字节、调用数、缓存、扫描与响应量。真实 `createDocumentRunContext` 也参与工具轨迹和模型调用记录，因此这些计数包含轨迹/usage 持久化；它们不是数据库网络往返耗时或真实 SQL 执行计划。

三次进程 maxRSS 分别为 **177,108 / 175,824 / 175,404 KiB**，中位数 **171.7 MiB**。cgroup memory peak 分别为 **134,414,336 / 131,325,952 / 131,092,480 字节**。二者记账口径不同：RSS 含进程映射驻留页，cgroup 指被该组计费的内存；不能互换。两者都覆盖文档准备、所有场景和 HTTP 客户端，不是单个请求增量或稳定常驻预算。该小型文档样本未发生 OOM，不证明任意大文库或最坏输入均能在同限额内运行。

所有并发批次按 FIFO 取得许可，结束后 `active=queued=users=0`；活动取消后不提交答案，排队取消不触发模型，未产生遗留任务或外部付费请求。

## 4. 本次冻结的性能回归口径与初始预算

相对门槛适用于**同一 fixture、相同 Node、硬限额、模型适配器和计时边界**，每次重新启动三个独立进程，取三次 p95 的中位数：

- 首字或总耗时中位 p95 超过 `本基线 × 1.5 + 5 ms`，必须调查再接受变更。5 ms 是微秒级合成任务的噪声缓冲，不是产品 SLA。
- 进程 maxRSS 中位数超过 `本基线 × 1.25 + 32 MiB`，必须调查。另保留 2 GiB cgroup 硬上限，任何 OOM/漏许可都判失败。
- 同一数据的普通问答保持 1 次主调用/0 工具/0 原文读取；固定文档读保持 2 次主调用/1 工具。新增标题/摘要调用必须单列，不能混入普通问答调用数。
- 活动与排队峰值分别不得超过 2/8；活动取消的答案提交数为 0，排队取消的模型调用数为 0，结束后的许可占用为 0。
- 固定样本的冷读字节和扫描字符不得增长；热读仍须 0 后端载入。需要扩大任务范围时先更新 fixture/口径并明确审阅，不能自动覆盖基线让结果变绿。

初始运行预算沿用当前代码实现，避免通过 M0 文档隐式扩大资源消耗：

| 预算 | 冻结值 | 来源 |
| --- | --- | --- |
| 活动 / 排队 / 排队超时 | 2 / 8 / 120 秒 | `createStreamAdmission` 默认值 |
| 单运行模型 / 工具调用 | 12 / 24 | `runWorkspaceAgent` 默认值 |
| stream 总截止 | 300 秒 | `handleWorkspaceStream` 默认值 |
| loader 缓存 / 条目 / 在途载入 | 32 MiB / 256 / 32 | `createArtifactLoader` 默认值 |
| 单次读 / 单运行返回正文 | 14,000 / 96,000 字符 | artifact 工具已有硬上限；一次最多 32 个节点 |
| 单次搜索 / 单运行扫描 | 128,000 / 1,000,000 字符 | artifact 词法搜索已有硬上限 |
| 单运行读取文档 | 8 | artifact 工作区已有硬上限 |

本轮未改任何上述实现。新增云端资源查询/本地通道预算需要各自固定样本；标题预算和真实辅助模型成本由独立样本记录负责，不能从这里的 mock 推导。

## 5. 复现

从包含本脚本的工作树运行，依赖已安装且本机存在指定镜像；使用 `--pull never` 防止基准自动安装/拉取。源码 SHA 表示被测业务基线，后续复测应改为当次 `git rev-parse HEAD`。结果只写任务专用临时目录。

```bash
qa_repo="$PWD"
qa_modules=$(readlink -f node_modules)
qa_results=$(mktemp -d /tmp/qa-m0-runtime.XXXXXX)
qa_source_sha=$(git rev-parse HEAD)
for qa_run in 1 2 3; do
  docker run --rm --pull never --network none \
    --cpus 2 --memory 2g --memory-swap 2g --pids-limit 128 \
    --user "$(id -u):$(id -g)" --workdir /work \
    --mount "type=bind,src=$qa_repo/scripts,dst=/work/scripts,readonly" \
    --mount "type=bind,src=$qa_repo/server,dst=/work/server,readonly" \
    --mount "type=bind,src=$qa_repo/shared,dst=/work/shared,readonly" \
    --mount "type=bind,src=$qa_modules,dst=/work/node_modules,readonly" \
    --mount "type=bind,src=$qa_results,dst=/results" \
    node:24.19.0-bookworm-slim node scripts/benchmark-qa-m0-runtime.mjs \
    --require-hard-limits --source-sha="$qa_source_sha" \
    --samples=30 --batches=10 --output="/results/run-$qa_run.json" || exit
done
node scripts/benchmark-qa-m0-runtime.mjs --source-sha="$qa_source_sha" \
  --aggregate="$qa_results/run-1.json,$qa_results/run-2.json,$qa_results/run-3.json" \
  --output="$qa_results/aggregate.json"
```

单次输出包含逐请求样本；聚合输出保存三次的每场景分位数、计数、内存、原始结果 SHA-256 和比较锚点，并检查版本/限额/fixture 一致以及热读零后端载入。`--require-hard-limits` 若读不到上表的实际 cgroup 限额立即失败，不会把无约束测量记成受限通过。

验证包括脚本语法检查、三轮运行中的语义断言与聚合一致性检查。本交付不部署服务、不增加运行遥测、不创建生产数据，也不将合成存储结果替代数据库计划或供应商实测。
