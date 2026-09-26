# 工作区 Agent M0：资源与协议冻结候选

日期：2026-09-26
核对基线：`fc091e6`（`output/qa-document-artifacts` 工作树）
状态：**推荐方案 / Schema 候选，尚未产品确认、尚未接入运行时**。

本文落实[升级计划](qa-workspace-agent-upgrade-plan-2026-09-26.md)的 M0 技术决定，配套[设计 Schema](contracts/qa-workspace-m0.schema.json)。Schema 仅用于设计审查与样本验证，不是当前 API 文档；没有执行迁移、开启功能或修改生产限额。所有下文“应”“返回”“保存”均描述拟实施行为，现状另列。

## 1. 已核对的实现与增量

| 已有实现 | 证据 | M0 决定的增量 |
| --- | --- | --- |
| 文档发现匹配标题、文件名、摘要；每页 10 条；受用户和未删除条件限制 | `server/qa/workspace/repository.mjs::discoverWorkspaceDocuments` | 扩展资源注册与白名单查询；统计由受限数据库聚合完成 |
| 产物协议有发现、目录、搜索、阅读 4 个工具；兼容协议另有 `cite_sources` | `server/qa/documentArtifacts/tools.mjs`、`server/qa/workspace/tools.mjs` | 增加 5 个通用只读工具；保留现有协议，不混合两条引用路线 |
| 版本化产物和实际读取回执产生 `R` 引用；用户/运行/产物快照受约束 | `server/qa/documentArtifacts/publishedReferences.mjs` | 非论文记录、查询口径、用户选文各用独立来源类型 |
| 会话手动改名、置顶、软删除/撤销、标题搜索；每次返回最多 30 条 | `server/supabase/qa.mjs::listQaThreadsForDocument`、`updateWorkspaceThread` | 分组、归档、真实续页、独立活动时间、标题保护与 CAS |
| 消息保存内容、状态、引用快照，没有本方案要求的消息 revision / 附件快照 | `server/supabase/qa.mjs::insertQaMessage`、`updateQaMessage` | 原子递增 revision；保存发送时附件与环境；任务依赖版本 |
| 首问压缩空白后截断成标题 | `server/supabase/qa.mjs::createThreadTitle` | 首个成功回答保存后，一次独立辅助调用；手动名优先 |
| 会话草稿是组件内状态 | `src/qa/WorkspaceChat.tsx`、`src/qa/PaperQaPanel.tsx::draftQuestion` | 用户隔离的本地持久化、提交 CAS、迟到响应保护 |
| 文库 UI 仓储能查集合、标签、阅读状态等，未成为当前 Agent 通用工具 | `src/cloud/pdfCloudRepository.ts` | 服务端专用适配器；不能直接 import 浏览器仓储，也不能把 `auth.uid()` RPC 原样当 service-role 接口 |

## 2. 资源 × 所在位置 × 操作 × 归属矩阵

操作记号：**发现 / 查询 / 读取 / 统计**。以下操作列是目标契约，不代表现有 Agent 已支持。`有条件`必须在结果中返回缺失原因；不可用不返回“0 条”替代。云端数据的存在以仓储/迁移代码为证据，未在本轮读取用户私有数据库。

| 资源与代码证据 | 云端 / 当前设备事实 | 目标操作 | 归属与版本 | 覆盖、限制与接入阶段 |
| --- | --- | --- | --- | --- |
| 文档书目 `src/cloud/pdfCloudRepository.ts` | 云端 `user_documents`；本地 PDF 条目含部分显示字段 | 四项 | 云端 `user_id` + 文档未删除；元数据 revision 或投影哈希 | M1；采纳值与待确认识别建议分开；现有 Agent 仅发现投影 |
| 集合/标签 `src/cloud/pdfCloudRepository.ts` | 云端 `user_collections` / `user_tags` 与关联表 | 四项 | 同用户集合/标签/文档同时核验 | M1；集合可递归浏览，统计明确直接成员/含子集合；多关联去重 |
| 文档收藏/阅读状态/归档 `src/cloud/pdfCloudRepository.ts` | 云端文档字段 | 四项 | 跟随所属文档 | M1；状态是当前值，不能推导读完时间或阅读时长 |
| 文档目录/正文/表格 `server/qa/documentArtifacts/` | 云端已发布产物；浏览器准备缓存 | 发现、查询、读取；统计限可观察页/节点 | 云端文档 + 产物 revision + 实际回执 | 已有正文路线继续；未解析只报不可用；不因查询自动上传/付费解析 |
| 云端笔记/高亮/摘录/译文 `src/cloud/documentStateRepository.ts` | `user_document_pins` 同条 payload 中保存多种内容 | 四项 | 用户 + 文档 + pin ID + 内容版本 | M1；一条 pin 是一个批注，笔记/译文是字段，不重复算多条批注；不是服务器核验论文原文 |
| 云端划词译文 `src/cloud/documentStateRepository.ts` | `user_translation_cache`；本地亦有副本 | 四项 | 用户 + 文档 + cacheKey + 版本 | M1；译文注明模型/语言/提示版本；不要当原文事实 |
| 云端术语/文档翻译约定 `src/cloud/documentStateRepository.ts`、`src/translation/paperContext.ts` | `user_paper_contexts` payload 中术语、摘要、风格等 | 四项；术语按 entry 计数 | 文档归属 + payload 版本 + entry identity | M1；旧结构缺逐词采纳证据时标记 `legacy_unknown`，不可把所有术语说成“用户确认” |
| 历史会话/消息/来源 `server/supabase/qa.mjs` | `user_qa_threads/messages/citations` | 四项 | 用户、未删除线程/消息；新增 revision | M1；失败/取消回答显式状态；历史回答仅是个人记录，回读原文另登记 |
| 会话组织 `src/qa/WorkspaceChat.tsx` | 已有置顶/标题；分组和归档尚未实现 | 四项 | 用户 + 线程/分组 revision | M2；删除分组只解除关系，归档可恢复，均不同于删除会话 |
| 阅读位置/最近打开 `src/cache/pdfLibraryRepository.ts`、`src/cloud/pdfCloudRepository.ts` | 本地覆盖写入 `lastPageIndex/lastScrollTop`；云端位置/最近打开字段 | 四项；统计限已记录的当前状态 | 云端归属；本地须隔离映射 | M1 云端、M4 本地；没有逐页轨迹或真实完成率 |
| 语言/文档偏好 `src/settings/settingsRepository.ts`、`src/cloud/settingsCloudRepository.ts` | 云端用户设置；本地 `settings['app']` 无用户键 | 发现、查询、读取；不作研究资料数量统计 | 云端用户；本地旧设置不得假定属于当前账号 | M1 只投影任务相关白名单，M4 补隔离；凭据和无关诊断配置不进入工具 |
| 可用性/调用用量 `src/cloud/qaApiLogCloudRepository.ts`、`src/settings/settingsRepository.ts` | 云端日志与本地日志各有部分记录 | 四项；仅受限投影/聚合 | 用户 + 时间范围 + 已记录口径 | M1 云端/M4 设备；排除原始诊断正文；缺日志不等于零费用 |
| **本地 PDF** `src/cache/pdfLibraryRepository.ts` | IndexedDB `pdfLibrary` 保存 Blob，键是 fingerprint | 发现、查询元数据、读取已有文字有条件、统计文件数 | 新 `ownerKey + contentSha256`；云关联核验或明确导入归属 | M4；不把 fingerprint 当所有权；工具不传 Blob/路径，不后台新抽取全文 |
| **已缓存 PDF.js 页文本** `src/pdf/PdfViewer.tsx::textContentCacheRef/pageIndexesRef` | 当前查看器内存 Map，不是持久 IndexedDB 页库 | 四项，仅已缓存页 | 当前会话绑定账号和文件哈希；刷新/卸载可丢失 | M4；报告 availablePages/cache lifetime；不得宣称缓存覆盖全书 |
| **已解析 MathPix 页面** `src/mathpix/mathpixRepository.ts` | IndexedDB `mathpixParsedPages`；云端 MathPix 对象存储/记录是另一副本 | 四项，仅已有解析页 | 本地 `[fingerprint,pageIndex]` 当前无用户键；新归属 + 文件/解析版本 | M4；文件哈希/解析配置不符拒绝合并；客户端结果仍为客户端材料 |
| **本地划词译文缓存** `src/translation/translationRepository.ts` | IndexedDB `translationCache`；可能尚未同步 | 四项 | cacheKey 当前未证明用户归属；新用户键 + 文档版本 | M4；云/本地相同记录按稳定身份合并，不只按相同文字去重 |
| **自由翻译历史** `src/translation/freeTranslationRepository.ts` | 当前浏览器，按 userId 过滤，最多 50 条/1,000,000 字符 | 四项 | 已有用户字段；新增记录版本投影 | M4；明确历史被裁剪，API 日志不能恢复正文；跨设备不可访问 |
| **自由翻译草稿** 同上 | `freeTranslationDrafts` 以 userId 为键 | 发现；用户指定草稿任务时查询/读取/统计 | 已有用户键 + 草稿 revision | M4；未发送草稿不默认为其他问题的上下文，计数是草稿数而非译文完成数 |
| **未同步批注/高亮/笔记** `src/pins/pinRepository.ts` | 本地先写，云同步失败仍保留；旧记录无用户键 | 四项，归属确认后 | 新用户键；cloud ID 只能辅助匹配，不能自证归属 | M4；保留本地/云端两个版本和冲突状态；不静默覆盖 |
| **未同步术语/文档风格** `src/translation/paperContext.ts` | `paperContexts` 按 fingerprint 存储 | 四项，任务相关字段 | 新用户键 + 文档/entry 版本 | M4；现有 `userEditedAt` 是记录级，不能推断每个术语已确认 |
| **会话草稿** `src/qa/PaperQaPanel.tsx` | 当前仅 React 状态，M2 才增加持久仓储 | 发现；明确草稿任务时查询/读取；统计草稿数 | 新 `userId + draftId/threadId` + revision | M2 持久化/M4 工具；不能把在途 run 当时的输入换成新草稿 |
| 固定翻译卡 `src/translation/pinnedTranslationCardRepository.ts` | 本地/云端有卡片呈现与关联状态 | 发现、读取关联；不单独重复计译文 | 按用户隔离 + 关联真实译文/批注 | M4；卡片是界面状态，展示位置不作为论文内容 |
| 当前环境/选区 `src/app/readerSessionRepository.ts`、`src/pdf/PdfViewer.tsx` | reader session 有 userId；选区是可变内存状态 | 读取本次冻结快照；不做历史统计 | 用户会话 + 捕获时刻 + 文件版本 | M3/M4；“当前”固定于发送时，不随阅读跳转改变 |

### 2.1 本地归属准入

1. 新本地记录使用独立的用户命名空间：`[ownerUserId, resourceKind, localRecordId]`；文件按 `[ownerUserId, contentSha256]` 关联，保留 fingerprint 用于旧代码定位。
2. 已知云端记录可通过认证请求确认相同用户、文档、记录 ID 和内容版本；本地新修改还必须携带在已认证命名空间中产生的 provenance。**仅核验当前账号拥有同一 PDF，不能证明遗留笔记属于这个账号。**
3. 无主旧记录 `ownership=unclaimed`，不进入内容查询/计数。用户明确选择导入/归属后复制进自己的命名空间，记录导入事件；不自动修改/删除原记录。
4. 自由翻译现有 userId 可作为本地业务隔离起点，服务端仍只把回传视为该账号提交的客户端资料，不提升为服务器读取回执。
5. 云/设备冲突返回 `syncState=conflict` 及各自版本。可按逻辑身份展示一组，内容比较保留两个版本；统计注明 `distinct logical records` 或 `versions`。

## 3. 推荐工具集与受限参数

版本名候选：`qa-workspace-access-v1`。首期全部只读。用户身份、run ID、线程访问权、设备会话、预算来自 harness；模型参数没有 `userId`、SQL、表名、文件路径、bucket、URL、任意字段表达式。

| 名称 | 参数 | 结果重点 |
| --- | --- | --- |
| `workspace_overview` | `location=cloud/current_device/combined`，可选 `resources[]`；默认 cloud，不强制每次调用 | 资源种类、能力、归属/可用性、覆盖；不隐式精确统计整库 |
| `workspace_query` | 首次：`resource`、`location`、该资源白名单 `filter`、`sort`、`limit`；续页仅 `cursor` | 简明卡片、运行内 record ref、pageCount、hasMore/nextCursor；total 默认不查 |
| `workspace_read` | 首次：`record`、`part=details/content/message_context`；消息上下文可 `before/after` 各 0–2；续读仅 `cursor` | 真正读到的字段/片段及来源，记录版本、可定位性、截断和续读 |
| `workspace_count` | `resource`、`location`、与 query 完全相同的 `filter`；可选该资源允许的 `groupBy` | distinct total、分组计数、统计时刻/口径；无正文 |
| `workspace_related` | `record`、受限 `relation`、`limit`；续页仅 `cursor` | 有证据的存储关系卡片；关系来源，分页 |

现有 `document_outline/search_document/read_document` 保留正文导航与回执逻辑；`discover_documents` 暂保兼容，不立即删除。旧 `cite_sources` 仅在旧协议使用。查询结果中的云文档卡片同时带本轮 `document` 句柄，可直接进入现有文档工具；本地文档只带可用性与本地资源 ref，不冒用云文档句柄。

### 3.1 注册表与白名单

Schema 对 resource 分支限定 filter/sort/groupBy；运行时适配器还须检查引用类型、字段适用性与关系两端权限。未知字段/资源/操作明确拒绝，不能安静忽略过滤器后给出更宽结果。

| resource | 可查询字段（均为固定结构） | 统计维度 | 读取与关系 |
| --- | --- | --- | --- |
| `document` | text(title/fileName/abstract)、year、readingStatus、starred、archived、collection、tags | year/readingStatus/collection/tag/archived | 元数据；正文走现有工具；collections/tags/annotations/translations/terms/messages/reading_state |
| `collection` / `tag` | text(name)、collection 的 parent；不任意递归表达式 | none | 显示资料；collection.children / documents，tag.documents |
| `annotation` | text(note/selectedText/translation)、documents、colors、hasNote、updated | document/color/hasNote | note/selection/translation 分字段；document |
| `translation` | text(source/translation)、documents、sourceLang/targetLang、updated | document/targetLang | 原文快照与译文；document |
| `term` | text(source/target)、documents、confirmation | document/confirmation | entry 与上下文版本；document |
| `thread` | text(title 或 messages，显式 searchIn)、group、archived、pinned、documents、updated | group/archived | 线程；messages |
| `message` | text(content)、threads、roles、statuses、created | role/status/thread | 消息/相邻消息；thread、sources |
| `reading_state` | documents、readingStatus、lastOpened | readingStatus | 当前位置，不返回不存在的历史序列；document |
| `preference` | keys（任务相关枚举） | 不支持 | 语言/文档翻译约定；不提供通用 settings 转储 |
| `availability` | resources、documents、states | resource/state | 解析/同步/位置可用性，不做原始日志转储 |
| `usage` | requestKinds、statuses、created | requestKind/status/model | 仅账面调用投影/聚合，缺 token 值为 unknown |
| `local_document` / `page_text` / `mathpix_page` | text（page text 仅已缓存）、documents/pages、updated | document；页资源可 state | 有限字段/已有页；document |
| `free_translation` | text(source/translation)、sourceLang/targetLang、created | targetLang | 保留的历史正文 |
| `free_translation_draft` / `conversation_draft` | text、updated；conversation 可 thread | 无分组 | 只有当前用户明确要求处理草稿时开放；未发送不作为旧消息 |

`text` 是字面关键词，不接收正则/SQL；最多 4 项，每项 200 字符，ANY/ALL 显式。多关键词改写用于词法召回，不默认 embedding/rerank。集合 `includeDescendants` 必填语义默认 false；标签 `mode=any/all` 默认 all；时间为 UTC 半开区间 `[from,to)`。排序固定枚举，空值规则固定，最终以稳定 ID 打破平局。阅读状态沿用源码 `inbox/to-read/reading/finished`，批注颜色沿用 `yellow/blue/green/red`，消息状态沿用 `streaming/success/error/aborted`，不新增同义枚举。

默认文档/线程查询 `archived=exclude`；用户要求“全部”使用 all。关联文档过滤来自保存的引用和输入附件关系，不来自当前打开的文章。集合/标签分组可重叠，组数之和允许大于 distinct total；零匹配与不可用严格区分。

### 3.2 统一结果信封

```json
{
  "ok": true,
  "contractVersion": "qa-workspace-access-v1",
  "data": { "items": [], "pageCount": 0, "hasMore": false, "nextCursor": null },
  "scope": {
    "location": "combined", "resource": "annotation", "asOf": "2026-09-26T00:00:00Z",
    "consistency": "live_keyset", "filterDigest": "sha256:…"
  },
  "coverage": {
    "state": "partial", "included": ["cloud"],
    "excluded": [{ "location": "current_device", "reason": "client_offline" }],
    "historyMayBePruned": false
  },
  "usage": { "returnedChars": 0, "scannedRecords": 0, "scannedChars": 0 },
  "truncated": false
}
```

卡片只含 `record/resource/title/preview/version/updatedAt/location/availability` 和已授权业务字段。候选 preview 不是已读完整内容；`workspace_read` 后才登记对应实际字段范围。工具错误为 `ok=false,error={code,message,retryable,details}`；候选错误码：`INVALID_ARGUMENTS`、`UNKNOWN_REFERENCE`、`INVALID_CURSOR`、`CURSOR_EXPIRED`、`RESOURCE_UNAVAILABLE`、`CLIENT_OFFLINE`、`OWNERSHIP_UNCLAIMED`、`VERSION_CHANGED`、`BUDGET_EXHAUSTED`。不通过错误泄露其他用户记录是否存在。

`coverage.state=complete` 仅针对声明的数据源/过滤范围，不意味着用户所有设备/被裁剪历史都已覆盖。组合统计只有确定逻辑身份才能去重；否则按 location 分开返回，禁止给伪精确联合 total。

### 3.3 游标

- 工具游标：运行内随机不透明 token，服务器保存 `user/run/tool/filterDigest/sort/lastTuple/pinnedResourceVersions/expiry`；续页参数只能是 cursor。
- 会话列表 API：不透明签名游标或服务端存储 token，绑定用户、过滤条件、排序、API 版本、过期时间；不能裸露 offset 冒称快照。推荐 keyset `(pinnedBucket,sortValue,id)`；置顶在每个筛选视图内优先。
- 列表是 `live_keyset`，活动时间变动可能让记录移动；UI 刷新首屏并按 ID 去重。统计是该 SQL 语句的 `asOf`，跨请求统计与列表不保证同一事务快照。
- 版本化正文保持当前固定产物快照。读记录后发生修改，原读取来源保留旧版本；要回答“最新”必须重读并登记新版本。
- 候选 TTL：工具游标随运行终止失效；会话游标 30 分钟。此值待分页/负载样本验证。

## 4. 来源与输入附件

### 4.1 来源类型

| sourceKind / 本轮引用 | 证明什么 | 不能证明什么 |
| --- | --- | --- |
| `document_artifact` / 原有 `R`、展示 `C` | 服务端授权的指定版本、实际读取范围与原文映射 | 语义论断必然成立、逐字高亮一定可用 |
| `workspace_record` / 候选 `W1` | 指定业务记录、版本、读取字段/范围 | 笔记/译文/历史模型回答等同论文事实 |
| `query_snapshot` / 候选 `Q1` | 执行时间、查询口径、数据源、精确或不完整计数 | 缺失设备、裁剪历史、未知费用也被覆盖 |
| `user_selection` / 候选 `U1` | 用户主动提交的不可变选文与几何/提取信息 | 客户端提供的正文已经服务器核验 |

来源内部共同字段：`sourceId/sourceKind/sourceVersion/authority/resourceIdentity/readScope/contentHash/capturedAt/availability/locator`；`userId/runId` 由服务器登记，模型不能填写。authority 仅服务端赋值：`server_verified_document/account_record/client_owned_record/user_supplied`。已读记录的 `readScope` 指明 fields 和 range；查询来源保存规范化过滤器与覆盖；客户端来源保存设备会话和回传摘要，不保存凭据。

新类型建议落到 `user_qa_sources`，`user_qa_message_sources` 记录答案/输入与来源关系；原 `user_qa_citations` 和老答案保持兼容读取。以上只是表名候选，不执行 migration。最终输出显示自然的“笔记 / 历史对话 / 统计口径 / 用户选文”来源卡；不要把所有内容渲染成 PDF 引用。

附带 Schema 的 `sourceRecord` 是新统一来源投影候选，不替换现有 document_artifact 的完整定位 Schema；真实产物仍由既有 `citation-locator-v2` 校验与保存。不同 run 的 W/Q/U/R/C 不能复用。重新回答重验权限，依据保存的资源身份与版本重新登记；文档删除/撤权后显示来源不可访问，不能暗中回绑新版或同名文件。

### 4.2 选文附件 `qa-input-attachments-v1`

```json
{
  "attachmentId": "uuid", "schemaVersion": "qa-input-attachments-v1", "revision": 1,
  "capturedAt": "2026-09-26T00:00:00Z", "kind": "text_selection",
  "document": { "displayName": "示例论文.pdf", "cloudDocumentId": null,
    "localFileId": "local-uuid", "contentSha256": "sha256:…" },
  "extraction": { "source": "pdfjs", "precision": "exact_selection", "availability": "available" },
  "selectionSegments": [{ "segmentId": "s1", "order": 0, "pageNumber": 3,
    "rawText": "user selected text", "normalizedText": "user selected text",
    "coordinateSpace": "pdf_points_top_left", "pageWidth": 595, "pageHeight": 842,
    "rects": [{ "x": 80, "y": 160, "width": 300, "height": 14 }] }],
  "contextSegments": [], "snapshotHash": "sha256:…"
}
```

- `rawText` 指捕获时可获得的原始选择文字；如果入口只剩整行 OCR，设 `precision=line_approximate`，`rawText=null`，`normalizedText` 保存实际可用文字。禁止重新命名整行为精确选文。
- 页使用对外 1-based `pageNumber`；选择顺序与页顺序分开保存；多页/不连续多段逐段保留，不自动填充中间未选内容。
- 坐标必须注明空间、页面尺寸、rotation（如适用）。若只得 viewport 像素，保存 capture scale/rotation，标注该坐标空间；转换后才能作为 PDF 定位，不把不同坐标混用。
- `contextSegments` 分开保存前后文，不能暗中并入用户选文；晚到 OCR 不修改已添加的附件。用户替换附件产生新 revision/hash。
- 发送时服务端忽略客户端声称的 `verified` 或任何来源句柄；验证云文档身份/版本后可额外登记 `document_artifact`，同时保留原始选文。
- 重复点击按 `document version + ordered segments + selection text hash` 去重；允许用户显式再次添加。没有文字只提示不可用，不建立空引用。
- 哈希用于一致性比较，不是数字签名，也不证明所有权。序列化规范推荐 `canonical-json-v1`：对象键排序、数组有序、原始文本不重写、禁止 NaN/undefined，UTF-8 后 SHA-256。

## 5. 消息 revision、标题 CAS 和会话 API

### 5.1 消息版本

推荐 `revision bigint NOT NULL DEFAULT 1`，另外保存 `input_snapshot_hash` 和 `terminal_content_hash`。保持现有 message ID，终态内容/附件/来源关系/删除状态等语义变化以同一事务递增 revision；流式 token、usage 累加、诊断时间不递增。删除与恢复也要递增，防止删除前任务在恢复后重新有效。

用户消息发送后正文与附件不可静默改写。重生回答沿用保存的用户输入快照，助手答案的新尝试有独立 attempt identity；若复用旧助手 message ID，则终态替换与 revision 增量原子提交。旧消息迁移在保留当前文字的前提下回填 revision=1 与 hash；该值不是完整历史版本档案。

### 5.2 标题状态与原子条件提交

线程建议增加 `title_source=temporary/auto/manual/legacy`、`title_revision`、`title_updated_at`、`last_activity_at`、`group_id`、`archived_at`、`lifecycle_revision`。辅助任务保存 source user/assistant message ID+revision、expected title/lifecycle revision、nonce、overwrite permission、model/prompt version、usage、state/attempt。

1. 主答案及来源提交成功后才创建一次标题任务；点击问 AI、输入草稿、失败回答不调用标题模型。
2. 任务只读取保存的问题、短回答片段和附件主题。独立模型配置复用既有凭据，无 Agent 工具。
3. **一个事务/RPC**锁定同用户线程和来源消息，校验未删除、标题版本、生命周期版本、来源 revision/hash、任务 nonce 和覆盖许可，再更新标题并将任务标为 committed。不能靠先 GET 再普通 UPDATE 达成 CAS。
4. 自动任务仅能替换 temporary；手动改名设 manual、title revision +1、失效旧 nonce；legacy 默认保留。手动动作与自动提交竞态下，以版本条件保证晚到自动任务不能抢改。
5. “重新生成标题”创建绑定发起时版本的一次性覆盖许可，可覆盖当时的 manual/legacy。之后再手动改名即使文字相同也使任务失效；重试 committed nonce 不重复写。
6. 删除/恢复线程递增 lifecycle revision。来源删除/重生使在途任务失效；已自动命名的来源失效时撤下自动标题并从剩余有效内容重建；manual 不改。
7. `last_activity_at` 只在用户消息提交/助手进入终态更新；不随 token、标题、置顶、分组、归档更新。旧数据用 updated_at 近似回填并记迁移事实。

建议 API 增量：`GET /api/qa/threads?cursor=&sort=&group=&archive=&searchIn=&q=&document=` 返回 `{items,hasMore,nextCursor}`；`PATCH` 线程带 `expectedRevision`；分组 CRUD 只由用户 UI 触发；自动标题用服务端任务入口，不暴露成模型可调工具。具体路由可沿已有路由组织落地，旧数组返回通过显式版本协商兼容，不静默改响应形状。

## 6. 草稿和发送边界

推荐 IndexedDB 新 `qaConversationDrafts`：主键 `[userId,draftId]`，索引 `[userId,threadId]`、`[userId,updatedAt]`。记录 `schemaVersion/draftId/threadId/revision/question/inputAttachments/composerState/updatedAt`；新会话 threadId=null。草稿默认设备内，不新增云同步。

- 点击问 AI 立即冻结附件，原草稿文字和既有附件保留；没有会话时新建本地草稿；已有回答在生成时写入下一条草稿。
- 发送建立不可变 `submissionId + expectedDraftRevision + inputSnapshot + environmentSnapshot`；服务器按用户/线程/submissionId 幂等。问题与附件各自预算，不能拼接绕过。
- 成功回调仅在草稿仍为 expectedDraftRevision 时清除已发部分；后续编辑 revision 已增则保留。失败恢复原快照时不能覆盖后续编辑，可作为“未发送内容”独立恢复项。
- 账号切换清理内存视图和客户端任务，读取只落当前账号键；不自动删除其他账号磁盘草稿。跨标签页用 IndexedDB 事务 CAS，BroadcastChannel 仅做通知，不作为一致性保证。
- 切会话只改对话区域，不改当前 PDF/页/滚动/布局。窄屏进入对话后提供返回阅读的路径并恢复阅读位置。
- 历史消息重生读取保存的 input/environment snapshot，忽略当前草稿、当前选区和当前阅读文章。

## 7. M4 客户端通道的最小契约

`client_tool_request` 由服务端派发，包含 `contractVersion/requestId/runId/clientSessionId/deadline/operation/resource/filter/allowedScope/limits`，均受服务端认证上下文约束；客户端能力列表仅声明可执行操作和可用范围，不授予资源权限。浏览器先验证账号和记录归属，执行白名单适配器。

回传 `{requestId,clientSessionId,result,resultDigest}` 绑定原请求；服务端通过认证主体查找在途请求、比较 run/期限/声明范围、限制长度、登记一次结果。重复相同 digest 幂等；不同 digest 冲突；取消、过期、旧标签页/账号、迟到响应不推进 run。默认主标签页租约，失去租约须重新协商，不让两标签页混合一份回传。

离线/关闭标签页返回明确 unavailable，云端任务可继续。持久恢复在 M6 扩展，M4 不承诺关闭浏览器后继续读取本机资料。客户端不能回传任意 URL/路径让服务器读取，也不能通过声明扩大文件范围。

## 8. 限额候选与必须补测项

现有值是代码观测，候选值是设计起点。**未测之前，不把候选称作已冻结性能指标。** 字符量统一按 UTF-16 code units 与现有 JS 实现对齐，UI 可显示字符近似；UTF-8 字节和模型 token 另外计量，不能互相等同。

| 项目 | 已有值/证据 | 推荐候选 |
| --- | --- | --- |
| 主循环 | maxCalls=12 / maxTools=24 / 单批最多 4；`server/qa/workspace/runtime.mjs` | 保持总预算，新工具共用，不每类另开 24 次 |
| 产物阅读 | 单次 14,000；单 run 96,000 字符；最多 8 文档 | 96,000 扩为所有读入工具资料共享上限，原产物上限不增加 |
| 产物扫描 | 单次 128,000；单 run 1,000,000 字符；`documentArtifacts/tools.mjs` | 本地/云新适配器各报扫描量，run 总字符扫描仍 1,000,000，最多 2,000 条轻量记录；超限 coverage partial |
| 卡片分页 | 发现 10，会话 30 | workspace_query 默认 10 最大 30；preview 300 字符；会话 30，查询 limit+1 得真实 hasMore |
| 读取/来源 | 现有原文最多 2,048 句柄；`publishedReferences.mjs` | 新增非原文来源最多 64/run；仍计共享总字符预算；最终展示遵循现有引用预算并单列不同种类 |
| 问题/附件 | 旧请求问题 slice(0,2000)、body 64 KiB；`server/routes/qa.mjs` | v2 问题上限 2,000，附件最多 4、选文每件 4,000、总 12,000、独立上下文总 4,000；v2 body 最大 128 KiB；任一超限明确拒绝，不静默截断 |
| 草稿 | QA 无持久上限 | 每用户 50 草稿、合计 5 MiB；达到上限提示管理，不自动删未发送内容；附件遵循发送上限 |
| 标题辅助 | 尚未实现 | 每用户并发 1，进程并发 1、低优先级；输入最多 1,200 tokens、输出最多 64、超时 15 秒、最多 1 次明确可重试失败重试；完成状态未知不盲目重付费 |
| 客户端工具 | 尚未实现 | 每 run 在途 1，15 秒超时；单结果 128 KiB；任务可取消；单批扫描按预算让出主线程 |
| 查询缓存 | 新通用缓存尚未实现 | 进程总 16 MiB、单用户 2 MiB、TTL 60 秒；键含用户/资源版本/查询/位置，不缓存无主数据；硬淘汰不删除业务数据 |

这些候选需要在原 2 CPU / 2 GB 目标约束下验证：查询/统计 SQL 计划，中文/英文/跨语言召回，正文/附件 token 开销，10 用户并发提交的有限排队与取消，内存峰值，标题与主任务争用，索引失效/修改后的覆盖。现有生产运行/排队配置本轮未读取，不填猜测数值。

## 9. 冻结条件与 M1/M2 开工清单

- 资源矩阵逐项有操作/归属/覆盖；云端与本地现状不再混称“已接通”。
- 操作 Schema 可编译，合法样本通过；身份/SQL/未知字段/错资源过滤器/混合 cursor 参数等反例被拒绝。
- 来源、附件、revision、标题 CAS、草稿冲突规则以本文为同一套候选；UI 文案/视觉稿与之相符。
- 产品确认推荐交互；固定评测集与当前基线可重跑。延迟、成本、并发等尚未测项目保留 pending，不通过文档日期冒充测量。
- 冻结后先实现 M1 服务端读适配器/来源保存，与 M2 会话/草稿并行；不把 M4 客户端协议当作 M1 已交付内容。

### 本轮设计验证结果

设计 Schema 使用仓库现有 Ajv 以 `strict: true, allErrors: true` 成功编译；合成样本 **20 个合法通过、25 个非法被拒绝**。覆盖五个工具、草稿、PDF.js 精确选文、MathPix 行近似、viewport 坐标、记录/查询/用户选文来源，以及列表/读取/计数/概览/错误结果。反例包含身份或 SQL 注入字段、资源过滤器不匹配、混合游标、伪造 verified、空/纯空白文字、空段列表、错误几何字段、负宽度、缺 capture scale、错误页码类型、来源权限类型混用和错误续页形状。

这些只证明设计的结构校验。JSON Schema 的 `maxLength` 按 Unicode code point 计数；候选预算按 UTF-16 计，实施时必须另用一致的长度函数校验。单件选文预算按各段 `max(rawText?.length ?? 0, normalizedText.length)` 求和，跨附件再求和；contextSegments 单独求和。附件总字符/字节、哈希真实性、坐标是否位于页面、资源句柄类型匹配、本地/云端归属和标题事务 CAS 仍需运行时/数据库验证，不能由这 45 个样本宣称通过。

复核命令（仓库根目录）：

```sh
node --input-type=module - <<'JS'
import fs from 'node:fs';
import Ajv from 'ajv';
const schema = JSON.parse(fs.readFileSync('docs/contracts/qa-workspace-m0.schema.json', 'utf8'));
const samples = JSON.parse(fs.readFileSync('docs/contracts/qa-workspace-m0.examples.json', 'utf8'));
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
for (const kind of ['valid', 'invalid']) {
  for (const [index, sample] of samples[kind].entries()) {
    if (validate(sample) !== (kind === 'valid')) throw new Error(`${kind}[${index}]: ${JSON.stringify(validate.errors)}`);
  }
}
console.log(`${samples.valid.length} valid, ${samples.invalid.length} invalid: PASS`);
JS
```
