# Paper QA Implementation Plan

## 0. 目标定位

本文记录一套成熟版论文问答系统的分步实现方案。目标不是在阅读器里增加一个轻量聊天框，而是把 PDF Translate Reader 扩展为可追溯、可同步、可审计的论文知识问答工作台。

核心能力：

- 围绕当前论文进行聊天式问答。
- 支持引用用户已导入文库中的其他论文。
- 回答必须带可校验引用，引用可以回到具体论文、页码和原文片段。
- 支持当前论文、当前论文加参考文献、文库集合三种问答范围。
- 支持问答会话保存、跨设备同步、API 调用统计和失败诊断。
- 后端统一负责检索、权限校验、引用校验和模型调用，前端负责交互、流式展示和引用跳转。

非目标：

- 不做公开互联网论文搜索。
- 不引用用户未导入全文的论文正文。
- 不允许模型自由编造论文、页码、作者或引用编号。
- 不把问答索引做成只存在浏览器里的临时功能。
- 当前阶段不实现视觉检索能力，包括页面截图理解、图表/公式区域检测、图片裁剪、多模态 embedding 和基于图像证据的回答。方案在数据模型和引用层保留 `page/bbox/source` 扩展空间，但第一期只处理 MathPix/PDF.js 得到的文本、MMD、页码和章节结构。

## 1. 产品形态

### 1.1 Ask 工作区

在 `ReaderShell` 中增加 `Ask` 工作区，与当前 annotations/pins 能力并列。桌面端建议在右侧栏使用 tab，移动端使用全屏抽屉或底部 sheet。

Ask 工作区包含：

- 范围选择：当前论文、当前论文加参考文献、文库。
- 参考论文选择器：列出已导入 PDF，支持搜索、最近打开、按标题排序。
- 问答线程列表：按当前论文和用户保存会话。
- 流式问答消息区。
- 多步检索过程面板：展示系统执行过哪些受控检索、阅读和证据缺口检查步骤。
- 证据抽屉：展示每条回答背后的 chunk、页码、章节路径、原文片段。
- 快捷问题：解释选中段落、总结本节、提炼方法、对比实验结果、查找限制与未来工作。

### 1.2 引用交互

回答中的引用统一展示为 citation chip：

```text
[当前论文 p.4]
[Smith 2023 p.7]
[Related Work p.2-3]
```

点击行为：

- 当前论文引用：跳转到对应页码，并可高亮证据片段附近区域。
- 其他已导入论文引用：打开该论文，跳转到页码，并保持 Ask 会话可返回。
- 未导入参考文献：只能展示 bibliography metadata，不能作为正文证据引用。

## 2. 总体架构

成熟版采用服务端 RAG 和本地缓存结合的架构。

```text
PDF 导入
  -> 保存文档和阅读状态
  -> 用户点击 MathPix 解析
  -> MathPix / PDF.js 文本解析
  -> 用户点击构建 QA 索引
  -> 文档结构化
  -> chunk 切分
  -> embedding + full-text index
  -> hybrid retrieval
  -> rerank
  -> controlled agent runner
     -> plan / search / inspect evidence / gap check / follow-up search
  -> evidence pack
  -> LLM answer stream
  -> citation verifier
  -> QA history + citation audit
```

关键原则：

- 以 MathPix 结果作为论文文本主来源，PDF.js 文本作为降级来源。
- 文档索引、embedding、问答会话和引用审计进入 Supabase，保持用户隔离。
- 检索在服务端执行，避免客户端传大段全文，也避免绕过权限控制。
- 回答模型只接收经过权限检查和检索排序后的 evidence pack。
- 引用数据以结构化记录存储，不依赖从回答 Markdown 中二次解析。
- PDF 导入和打开文档不触发 MathPix、embedding 或 QA 索引等重计算；所有重计算入口都必须是用户显式点击。
- 多步检索只暴露结构化过程摘要，不展示或存储模型原始 chain-of-thought；用户看到的是 plan、tool call、observation 和 evidence gap summary。

### 2.1 视觉检索边界

ChatGPT、Claude、Gemini 等成熟文档问答系统通常会把 PDF 处理拆成两条路线：

- 文本 RAG：抽取文本、切块、embedding、检索、回答、引用。
- 视觉检索：渲染页面图像，识别图表/公式/图片区域，裁剪证据块，用视觉模型或多模态 embedding 生成可检索证据。

本方案第一阶段只实现文本 RAG。暂不实现视觉检索，原因：

- 当前项目的核心优势是 MathPix/PDF.js 文本解析、页码定位、翻译和阅读状态同步，文本 RAG 可以复用这些能力。
- 视觉检索会显著增加存储、GPU/视觉模型调用、图像裁剪、bbox 对齐和引用校验复杂度。
- 当前部署环境是低配置 CPU 公网服务器，不适合自托管视觉模型或大规模页面图像处理。

需要预留的兼容点：

- `QaCitation` 后续可以增加 `bbox`、`evidenceType: "text" | "figure" | "table" | "page-image"`。
- `user_paper_chunks` 后续可以拆出 `user_paper_visual_evidence`，保存 page image crop、caption、bbox、视觉摘要和多模态 embedding。
- 引用跳转逻辑应按 `page_start/page_end` 实现第一版，后续再叠加 bbox 高亮。

### 2.2 部署原则：VPS 控制面 + 私有计算 worker

成熟 RAG 不要求公网 VPS 承担重计算。当前项目推荐采用“VPS 公网入口/控制面 + 当前服务器私有计算 worker + 托管状态层”的三层架构：

- VPS 运行 Nginx/HTTPS、静态前端、轻量 Node API、鉴权、限流、任务创建、SSE 网关和健康检查。
- 当前服务器运行 `qa-worker`，承担文档结构化、chunking、embedding、向量检索、rerank、可选本地模型推理等重计算。
- Supabase/Postgres 保存用户、文档、QA job、chunk、message、citation 和审计状态，作为 API 与 worker 的共享状态层。
- VPS 和当前服务器之间通过私有通道通信，例如 SSH reverse tunnel、WireGuard/Tailscale、内网专线或仅监听 loopback 的反向端口。
- 索引任务必须异步化，VPS 只创建 job 并查询状态，worker 消费 job 后写回数据库。
- 问答流式请求可以由 VPS 做 SSE gateway，认证和权限校验在 VPS/数据库完成，重计算和模型流由 worker 执行。

这种部署方式下，VPS 只承受公网入口和控制面压力；当前服务器可以承担重计算，但不直接暴露公网。后续如果 worker 压力变大，可以横向增加 worker 或迁移到更高配置机器，不需要重做前端和公网入口。

## 3. 数据模型

### 3.1 前端领域类型

新增 `src/types/domain.ts` 类型：

```ts
export type QaScope = "current" | "current-plus-references" | "library";
export type QaChatModel = "deepseek-v4-pro" | "glm-5.2";

export type QaChunk = {
  id: string;
  cloudDocumentId: string;
  pdfFingerprint: string;
  chunkIndex: number;
  chunkHash: string;
  title?: string;
  sectionPath?: string[];
  pageStart: number;
  pageEnd: number;
  text: string;
  mmd?: string;
  tokenCount: number;
  source: "mathpix-v3-pdf" | "pdfjs";
  chunkerVersion: string;
  createdAt: number;
  updatedAt: number;
};

export type QaCitation = {
  id: string;
  messageId: string;
  chunkId: string;
  cloudDocumentId: string;
  pdfFingerprint: string;
  documentTitle: string;
  pageStart: number;
  pageEnd: number;
  sectionPath?: string[];
  quotedText: string;
  confidence: "verified" | "weak" | "rejected";
};

export type QaRetrievedEvidence = {
  evidenceId: string;
  chunkId: string;
  cloudDocumentId: string;
  pdfFingerprint: string;
  documentTitle: string;
  pageStart: number;
  pageEnd: number;
  sectionPath?: string[];
  score: number;
  scoreBreakdown: {
    vector?: number;
    fullText?: number;
    metadataBoost?: number;
    rerank?: number;
  };
  textPreview: string;
};

export type QaRetrievalSnapshot = {
  scope: QaScope;
  activeCloudDocumentId?: string;
  referenceDocumentIds: string[];
  queryPlan: {
    intent: string;
    rewrittenQueries: string[];
    requiredEvidence: "single" | "multi" | "comparison";
    answerFormat: "paragraph" | "bullets" | "table";
  };
  retrieverVersion: string;
  rerankerVersion?: string;
  evidence: QaRetrievedEvidence[];
};

export type QaAgentStepKind =
  | "plan"
  | "tool_call"
  | "observation"
  | "gap_check"
  | "answer_outline";

export type QaAgentToolName =
  | "search_current_paper"
  | "search_reference_papers"
  | "search_library"
  | "open_chunk"
  | "compare_evidence"
  | "verify_citation"
  | "compose_answer";

export type QaAgentStep = {
  id: string;
  messageId: string;
  stepIndex: number;
  kind: QaAgentStepKind;
  summary: string;
  toolName?: QaAgentToolName;
  toolCallId?: string;
  evidenceIds?: string[];
  createdAt: number;
};

export type QaToolCall = {
  id: string;
  stepId: string;
  toolName: QaAgentToolName;
  input: unknown;
  outputSummary: string;
  resultEvidenceIds: string[];
  status: "success" | "error" | "skipped";
  errorMessage?: string;
  startedAt: number;
  finishedAt?: number;
};

export type QaThread = {
  id: string;
  activeCloudDocumentId?: string;
  title: string;
  scope: QaScope;
  referenceDocumentIds: string[];
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
};

export type QaMessage = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "success" | "error" | "aborted";
  model?: QaChatModel;
  agentSteps?: QaAgentStep[];
  citations: QaCitation[];
  retrievalSnapshot?: QaRetrievalSnapshot;
  usage?: TokenUsage;
  createdAt: number;
  updatedAt: number;
};
```

### 3.2 Supabase schema

新增 Postgres 扩展：

```sql
create extension if not exists vector;
create extension if not exists pg_trgm;
```

新增表：

- `public.user_paper_chunks`
- `public.user_paper_references`
- `public.user_qa_threads`
- `public.user_qa_messages`
- `public.user_qa_citations`
- `public.user_qa_index_jobs`
- `public.user_qa_agent_steps`
- `public.user_qa_tool_calls`

#### user_paper_chunks

```sql
create table if not exists public.user_paper_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid not null references public.user_documents(id) on delete cascade,
  pdf_fingerprint text not null,
  content_sha256 text not null,
  chunk_index integer not null,
  chunk_hash text not null,
  title text,
  section_path text[],
  page_start integer not null,
  page_end integer not null,
  text text not null,
  mmd text,
  source text not null check (source in ('mathpix-v3-pdf', 'pdfjs')),
  token_count integer not null default 0,
  chunker_version text not null,
  embedding_model text,
  embedding_dimensions integer,
  embedding vector(1024),
  fts tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(array_to_string(section_path, ' '), '') || ' ' || text)
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_document_id, chunker_version, chunk_hash)
);
```

索引：

```sql
create index if not exists user_paper_chunks_user_document_idx
  on public.user_paper_chunks (user_id, user_document_id, chunk_index)
  where deleted_at is null;

create index if not exists user_paper_chunks_fts_idx
  on public.user_paper_chunks using gin (fts);

create index if not exists user_paper_chunks_embedding_idx
  on public.user_paper_chunks using hnsw (embedding vector_cosine_ops)
  where deleted_at is null
    and embedding_model = 'voyage-4-large'
    and embedding_dimensions = 1024;
```

Embedding 默认锚定为 Voyage `voyage-4-large`，维度固定为 1024。后续如果切换模型或维度，必须新增迁移、重建 embedding，并固定新的 `embedding_model + embedding_dimensions`；不允许同一生产向量索引混用不同维度的向量。

#### user_paper_references

```sql
create table if not exists public.user_paper_references (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid not null references public.user_documents(id) on delete cascade,
  reference_index text,
  raw_text text not null,
  title text,
  authors text[],
  year integer,
  doi text,
  arxiv_id text,
  matched_user_document_id uuid references public.user_documents(id) on delete set null,
  match_confidence double precision,
  matcher_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
```

#### user_qa_threads / messages / citations

```sql
create table if not exists public.user_qa_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  active_user_document_id uuid references public.user_documents(id) on delete set null,
  title text not null,
  scope text not null check (scope in ('current', 'current-plus-references', 'library')),
  reference_document_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.user_qa_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.user_qa_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  status text not null check (status in ('streaming', 'success', 'error', 'aborted')),
  content text not null,
  model text,
  prompt_version text,
  retrieval_snapshot jsonb,
  usage jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.user_qa_citations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null references public.user_qa_messages(id) on delete cascade,
  chunk_id uuid not null references public.user_paper_chunks(id) on delete restrict,
  user_document_id uuid not null references public.user_documents(id) on delete restrict,
  page_start integer not null,
  page_end integer not null,
  quoted_text text not null,
  confidence text not null check (confidence in ('verified', 'weak', 'rejected')),
  created_at timestamptz not null default now()
);
```

#### user_qa_agent_steps / tool_calls

```sql
create table if not exists public.user_qa_agent_steps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null references public.user_qa_messages(id) on delete cascade,
  step_index integer not null,
  kind text not null check (kind in ('plan', 'tool_call', 'observation', 'gap_check', 'answer_outline')),
  summary text not null,
  tool_name text,
  evidence_ids text[] not null default '{}',
  payload jsonb,
  created_at timestamptz not null default now(),
  unique (message_id, step_index)
);

create table if not exists public.user_qa_tool_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  step_id uuid not null references public.user_qa_agent_steps(id) on delete cascade,
  tool_name text not null check (
    tool_name in (
      'search_current_paper',
      'search_reference_papers',
      'search_library',
      'open_chunk',
      'compare_evidence',
      'verify_citation',
      'compose_answer'
    )
  ),
  input jsonb not null,
  output_summary text,
  result_evidence_ids text[] not null default '{}',
  status text not null check (status in ('success', 'error', 'skipped')),
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
```

#### user_qa_index_jobs

```sql
create table if not exists public.user_qa_index_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid not null references public.user_documents(id) on delete cascade,
  content_sha256 text not null,
  status text not null check (
    status in ('pending', 'extracting', 'chunking', 'embedding', 'reference-matching', 'ready', 'ready_degraded', 'error')
  ),
  chunker_version text not null,
  embedding_model text not null default 'none',
  embedding_dimensions integer,
  retriever_version text,
  progress_percent double precision,
  error_message text,
  payload jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_document_id, chunker_version, embedding_model)
);
```

所有表必须启用 RLS，策略保持和现有 `user_documents`、`user_mathpix_documents` 一致：用户只能管理自己文档派生出来的索引、问答和引用记录。

### 3.3 IndexedDB 本地缓存

IndexedDB 只缓存最近访问数据，不作为权威索引：

- `qaThreads`
- `qaMessages`
- `qaCitations`
- `qaIndexStatus`

本地缓存用于离线查看历史问答和减少打开延迟。问答请求、索引构建和引用校验仍以后端和 Supabase 为准。

## 4. 索引流水线

### 4.1 手动触发策略

PDF 导入、打开文档、云端同步和 MathPix 缓存命中都不能自动触发重计算。系统只更新状态和可用操作，真正的 MathPix 解析和 QA 索引必须由用户显式点击。

触发入口：

- 用户点击“开始 MathPix 解析”：才启动现有 MathPix pipeline，提交 PDF、轮询状态、写入 `user_mathpix_documents` 和 MathPix 缓存。
- 用户点击“构建问答索引”：才创建 `user_qa_index_jobs`，进入文档结构化、chunking、embedding、reference matching。
- 用户点击“重建问答索引”：才对已存在索引创建新版本 job。
- `chunker_version`、`embedding_model` 或 `reference_matcher_version` 升级后，只把索引标记为 stale，不自动后台重建；Ask 面板提示用户手动重建。

依赖规则：

- MathPix 未完成时，Ask 面板优先提示用户点击“开始 MathPix 解析”。
- 用户也可以选择“使用 PDF 内置文本构建索引”，作为质量较低的降级路径；该路径必须在 UI 中明确标注可能缺公式、表格和版面信息。
- MathPix 完成后，只更新“可构建 QA 索引”的状态，不自动创建 QA index job。

### 4.2 MathPix 手动解析

当前阅读器已有 MathPix pipeline。QA 方案要求调整触发语义：

- 导入 PDF、打开 PDF、恢复阅读会话、云端 hydrate 和本地缓存命中都不能自动提交 MathPix。
- 阅读器顶部或 Ask 面板展示 MathPix 状态，但只在用户点击“开始 MathPix 解析”后运行 pipeline。
- 如果云端已经有同一 `contentSha256 + MATHPIX_OPTIONS_HASH` 的 completed cache，用户点击后可以直接复用缓存，不需要再次提交上游 MathPix。
- 如果已有 submitted/processing 记录，用户点击后进入继续轮询或查看进度，不重复提交。
- 如果用户不想等待 MathPix，可在 Ask 面板选择“使用 PDF 内置文本构建索引”，但该索引必须记录 `source: "pdfjs"` 并在 UI 中显示质量降级提示。

实现要求：

- 保留 `user_mathpix_documents` 作为 MathPix 状态来源。
- `ReaderShell` 不再使用打开文件后的后台延迟自动解析作为 QA 的默认行为。
- “开始 MathPix 解析”按钮调用现有 pipeline，并复用已有状态 chip 展示上传、处理、缓存、完成、失败。
- MathPix 完成后只刷新 Ask 面板和索引可用状态，不自动调用 `createOrUpdateIndexJob`。

### 4.3 索引状态

新增 `user_qa_index_jobs`：

```text
pending -> extracting -> chunking -> embedding -> reference-matching -> ready
                                            -> ready_degraded
                                            -> error
```

UI 展示：

- MathPix 未启动：Ask 面板提示用户点击“开始 MathPix 解析”，不自动提交。
- MathPix 处理中：展示阶段和进度。
- MathPix 已完成但未索引：Ask 面板提示用户点击“构建问答索引”。
- 未索引：Ask 面板提示问答索引尚未构建，并展示手动构建入口。
- 索引中：展示阶段和进度。
- 降级可用：没有 embedding 或 rerank 时允许 full-text + metadata boost 问答，同时提示“语义检索不可用”。
- 可用但过期：允许问答，同时提示用户手动重建。
- 失败：允许查看错误，提供重试。

### 4.4 文档结构化

新增 `server/qa/documentParser.mjs`：

- 优先读取 MathPix `pagesStoragePath` 和 `fullMmdStoragePath`。
- 生成按页文本、MMD、章节标题候选。
- 提取 title、abstract、section path、references 区域。
- 保存结构化中间结果到索引 job payload，方便失败重试。

章节识别优先级：

1. MathPix MMD 标题标记。
2. PDF metadata 和 paper context。
3. 基于行文本的标题规则。
4. 无法识别时使用页码作为弱结构。

### 4.5 Chunk 切分

新增 `server/qa/chunker.mjs`：

- 基础单位：段落或公式邻近段落。
- 目标大小：700-1100 tokens。
- 重叠：200-400 tokens。
- 不跨越明显章节边界。
- 表格、公式说明和紧邻解释尽量放在同一 chunk。
- 每个 chunk 保留 `page_start/page_end/section_path/chunk_hash`。

`chunk_hash` 由以下字段生成：

```text
content_sha256
chunker_version
page_start
page_end
normalized_text
```

### 4.6 Embedding

新增 `server/embedding/client.mjs`，统一 provider 接口：

```js
export async function embedTexts({ texts, model, signal }) {
  return {
    model,
    dimensions,
    vectors,
    usage,
  };
}
```

推荐支持：

- 当前阶段默认使用 Voyage 托管 API：`voyage-4-large`。
- 默认向量维度固定为 1024，对应 Supabase `pgvector` 的 `vector(1024)`。
- 默认落地顺序：先保留 full-text + metadata boost 降级路径，再启用 `voyage-4-large` vector retrieval；provider 不可用时进入 `ready_degraded`。
- 可选：本地 embedding 服务，只适合后续有独立算力或强隐私诉求的私有部署；公网 VPS 不推荐自托管 embedding，当前服务器可在 `qa-worker` 中承载这类能力。

环境变量：

```bash
VOYAGE_API_KEY=
EMBEDDING_PROVIDER=voyage
EMBEDDING_MODEL=voyage-4-large
EMBEDDING_DIMENSIONS=1024
EMBEDDING_BATCH_SIZE=64
```

索引写入必须记录 `embedding_model` 和 `embedding_dimensions`。当模型或维度变化时，旧 chunk 不可混用，必须重建或迁移到新 embedding 列/索引。第一期不要在同一张 `user_paper_chunks.embedding` 中混用 `voyage-4-large` 与其他维度的 embedding。

## 5. 检索与重排

### 5.1 服务端检索 API

新增内部模块 `server/qa/retriever.mjs`，不直接暴露给浏览器。

浏览器调用 `/api/qa/stream`，后端根据用户身份和 scope 决定可检索文档集合：

```ts
type QaStreamRequest = {
  question: string;
  activeDocumentId?: string;
  scope: "current" | "current-plus-references" | "library";
  referenceDocumentIds?: string[];
  threadId?: string;
  selectedTextContext?: {
    text: string;
    pageIndex?: number;
  };
  model: "deepseek-v4-pro" | "glm-5.2";
  executionMode: "rag" | "agentic";
  answerLanguage: "auto" | "zh" | "en";
};
```

### 5.2 Query planning

新增 `server/qa/queryPlanner.mjs`：

分类问题类型：

- definition：概念解释。
- method：方法细节。
- result：实验结果。
- comparison：跨论文比较。
- limitation：局限性。
- citation_lookup：寻找某个引用或相关工作。
- summary：章节或全文总结。

输出：

```ts
type QaQueryPlan = {
  intent: string;
  rewrittenQueries: string[];
  requiredEvidence: "single" | "multi" | "comparison";
  preferCurrentDocument: boolean;
  answerFormat: "paragraph" | "bullets" | "table";
};
```

### 5.3 Hybrid retrieval

检索使用三路信号：

- vector similarity：语义相似度。
- full-text search：术语、缩写、公式名、数据集名。
- metadata boost：当前论文、章节、标题、摘要、reference match。

默认权重：

```text
semantic vector: 0.50
full-text:       0.30
metadata boost:  0.20
```

跨论文比较时降低当前论文 boost，避免结果被当前论文淹没。

### 5.4 Rerank

新增 `server/qa/reranker.mjs`：

- 第一版默认使用 Voyage 托管 reranker：`rerank-2.5`。
- `rerank-2.5` 只在 query-time 对粗召回候选重排，不参与离线索引。
- 没有 rerank provider 时，使用 hybrid score 降级。`qa-worker` 可以承载 rerank，但 rerank 必须是可选能力，不应阻塞 QA 主流程。
- 从 top 50-80 重排到 top 8-15。

Rerank 输入只包含短文本和元数据，避免把整篇论文塞进模型。

默认配置：

```bash
QA_RERANK_PROVIDER=voyage
QA_RERANK_MODEL=rerank-2.5
QA_RERANK_CANDIDATE_LIMIT=80
QA_RERANK_TOP_K=12
```

### 5.5 Evidence pack

最终传给回答模型的 evidence pack 格式：

```text
[C1]
Document: Paper Title
Document ID: ...
Pages: 4-5
Section: Method / Training Objective
Text:
...

[C2]
...
```

每个 evidence id 只在本次回答内有效。服务端保存 `evidence_id -> chunk_id` 映射，用于后续引用校验。

### 5.6 受控多步检索 Agent Runner

普通 RAG 只执行一次检索和一次回答。成熟论文 QA 需要支持受控多步检索，用来处理跨论文比较、证据不足、引用追踪和复杂方法解释。

新增 `server/qa/agentRunner.mjs`，在 `/api/qa/stream` 内由 `executionMode` 控制：

- `rag`：执行 query planning、hybrid retrieval、rerank、answer composer。
- `agentic`：执行 plan / tool call / observation / gap check 循环，再进入 answer composer。

Agent runner 可以使用的工具必须白名单化：

```ts
type QaAgentToolName =
  | "search_current_paper"
  | "search_reference_papers"
  | "search_library"
  | "open_chunk"
  | "compare_evidence"
  | "verify_citation"
  | "compose_answer";
```

受控循环：

```text
queryPlanner
  -> initial plan
  -> search tool call
  -> observation summary
  -> gapAnalyzer
  -> optional follow-up search
  -> evidence consolidation
  -> answer composer
  -> citation verifier
```

硬性边界：

- 最大 agent steps：8。
- 最大检索 tool calls：4。
- 最大打开 chunk 数：20。
- 最大 evidence pack tokens：按模型上下文预算动态裁剪。
- 如果连续两轮没有新增 evidence，必须停止。
- 如果 gap analyzer 判断证据不足，最终回答必须明确说明证据不足。
- 不展示、不保存模型原始 chain-of-thought，只保存结构化 `summary`、`toolName`、`toolInput` 摘要和 evidence ids。

SSE 新增事件：

```text
event: agent_step
event: tool_call
event: observation
event: gap_check
```

前端展示这些事件为“检索过程”，例如：

```text
1. 判断为跨论文比较问题。
2. 检索当前论文的方法和贡献章节。
3. 检索已导入参考论文的实验设置。
4. 发现缺少参考论文限制部分证据，继续检索 limitation。
5. 汇总证据并生成回答。
```

这些过程摘要用于用户理解系统查了哪里、为什么继续查、哪些证据支持答案；它不是模型私密推理文本。

## 6. 回答生成与引用校验

### 6.1 API 模型选型

QA 回答模型锚定为双模型策略：

- `deepseek-v4-pro`：默认模型，适合高质量中文/英文论文问答、方法解释和长上下文证据综合。
- `glm-5.2`：备用或可选模型，适合交叉验证回答、模型降级、中文交互和与 DeepSeek 输出做差异对照。

命名约定：UI 展示名使用 `DeepSeek V4 Pro` 和 `GLM 5.2`，代码和数据库中的稳定枚举使用 `deepseek-v4-pro` 和 `glm-5.2`。

前端模型选择只暴露这两个选项，不再沿用翻译功能里的 `deepseek-v4-flash`。翻译模型和 QA 模型分开配置，避免为了问答质量牺牲翻译成本控制。

后端新增统一 chat model adapter，而不是把 QA 绑定到 DeepSeek：

```text
server/chatModels/
  client.mjs
  deepseek.mjs
  glm.mjs
```

统一接口：

```js
export async function createQaChatStream({ messages, model, signal }) {
  // model: "deepseek-v4-pro" | "glm-5.2"
}

export async function createQaChatCompletion({ messages, model, signal }) {
  // Used by query planner, gap analyzer, reranker, and answer verifier when needed.
}
```

模型用途建议：

- answer composer：用户选择的 `deepseek-v4-pro` 或 `glm-5.2`。
- query planner：默认使用 `deepseek-v4-pro`，可配置为 `glm-5.2`。
- gap analyzer：默认使用与 answer composer 相同模型，降低跨模型语义偏差。
- citation verifier：优先规则校验，必要时再用 `deepseek-v4-pro` 或 `glm-5.2` 做弱证据判别。

环境变量：

```bash
QA_DEFAULT_CHAT_MODEL=deepseek-v4-pro
QA_AVAILABLE_CHAT_MODELS=deepseek-v4-pro,glm-5.2

DEEPSEEK_API_KEY=
DEEPSEEK_API_BASE_URL=
DEEPSEEK_QA_MODEL=deepseek-v4-pro

GLM_API_KEY=
GLM_API_BASE_URL=
GLM_QA_MODEL=glm-5.2
```

### 6.2 API 路由

新增：

- `server/routes/qa.mjs`
- `server/qa/prompt.mjs`
- `server/qa/citationVerifier.mjs`
- `server/qa/agentRunner.mjs`
- `server/chatModels/client.mjs`
- `src/qa/qaClient.ts`

`server/index.mjs` 中新增鉴权路由：

```text
POST /api/qa/stream
```

沿用当前翻译接口的 SSE 风格，新增事件：

```text
event: retrieval
event: agent_step
event: tool_call
event: observation
event: gap_check
event: citation
event: delta
event: usage
event: verifier
event: done
event: error
```

### 6.3 Prompt 约束

`server/qa/prompt.mjs` 的系统提示必须包含：

- 只能基于 evidence pack 回答。
- 每个关键结论都要引用 evidence id。
- 不得引用未提供的论文或页码。
- 证据不足时明确说明证据不足。
- 比较型问题优先输出表格。
- 回答语言跟随用户问题，除非请求指定 `answerLanguage`。
- 不输出隐藏推理过程，不声称自己访问了 evidence pack 之外的资料。
- 可以输出简短“检索过程摘要”，但只能来自 `user_qa_agent_steps.summary`，不能输出原始 chain-of-thought。

建议回答格式：

```markdown
正文段落，关键结论后接 [C1]。

References used:
- [C1] Paper Title, p.4, Method
- [C2] Another Paper, p.7, Experiments
```

### 6.4 Citation verifier

回答完成后，服务端执行引用校验：

1. 提取回答中的 `[C1]` 形式引用。
2. 检查 evidence id 是否存在于本次 retrieval。
3. 检查 chunk 是否属于当前用户可访问文档。
4. 检查 citation 对应页码、标题、chunk id 是否一致。
5. 标记 `verified`、`weak` 或 `rejected`。
6. 对不存在的引用做降级处理：移除引用并在 verifier event 中返回警告。

严格模式下，如果回答包含大量无引用断言，服务端应返回 verifier warning，UI 展示“部分结论缺少直接证据”。

### 6.5 存储问答记录

每次问答保存：

- user message。
- assistant message。
- retrieval snapshot。
- agent steps and tool calls。
- usage。
- verified citations。
- error status。

保存顺序：

1. 创建或读取 thread。
2. 写入 user message。
3. 检索并创建 assistant message placeholder。
4. 流式生成。
5. 完成后更新 assistant content、usage、citations。
6. 失败时写入 error status，便于用户复盘。

## 7. 跨论文引用

### 7.1 Reference extraction

新增 `server/qa/referenceExtractor.mjs`：

- 从 references section 中解析 bibliography entry。
- 提取 `reference_index/title/authors/year/doi/arxiv_id/raw_text`。
- 无法解析时保留 raw text，不影响索引。

### 7.2 Reference matching

新增 `server/qa/referenceMatcher.mjs`：

匹配优先级：

1. DOI 精确匹配。
2. arXiv id 精确匹配。
3. 标题归一化后精确匹配。
4. 标题 trigram similarity + 作者年份。

匹配结果写入 `user_paper_references.matched_user_document_id`。

### 7.3 Scope 规则

`current`：

- 只检索当前论文 chunk。

`current-plus-references`：

- 检索当前论文。
- 检索已匹配且已导入的参考论文。
- 未导入参考文献只作为 bibliography metadata 展示，不能进入 evidence pack。

`library`：

- 检索用户手动选择的论文集合。
- 如果用户没有选择集合，默认检索当前论文和最近打开的若干篇，但 UI 必须明确显示范围。

## 8. 前端实现

### 8.1 新增目录

```text
src/qa/
  PaperQaPanel.tsx
  QaThreadList.tsx
  QaMessageList.tsx
  QaMessage.tsx
  QaComposer.tsx
  CitationChip.tsx
  EvidenceDrawer.tsx
  ReferenceScopePicker.tsx
  qaClient.ts
  qaRepository.ts
  qaTypes.ts
```

### 8.2 ReaderShell 集成

`ReaderShell` 增加状态：

- `activeRightPanel: "annotations" | "ask"`
- `qaThreadId`
- `qaScope`
- `selectedReferenceDocumentIds`
- `citationLocateRequest`

引用跳转：

- 当前文档：复用 `PdfViewer` 的定位能力，跳页并滚动。
- 其他文档：调用 `openCloudPdfDocument` 打开对应 PDF，记录返回来源，跳页。

### 8.3 UI 状态

Ask 面板必须处理：

- API offline。
- 未登录。
- 当前文档未上传云端。
- MathPix 未启动，显示“开始 MathPix 解析”入口。
- MathPix 解析中，显示进度但不允许重复提交。
- MathPix 未完成。
- MathPix 已完成但 QA 索引未启动，显示“构建问答索引”入口。
- QA 索引未构建。
- 索引构建中。
- 索引过期但可用。
- 检索无结果。
- 模型流式失败。
- 引用校验 warning。

### 8.4 i18n

新增 message key 前缀：

- `qa.title`
- `qa.scope.current`
- `qa.scope.currentPlusReferences`
- `qa.scope.library`
- `qa.index.ready`
- `qa.index.processing`
- `qa.askPlaceholder`
- `qa.evidence`
- `qa.citation.open`
- `qa.citation.unavailable`
- `qa.verifier.warning`

## 9. 后端实现

### 9.1 路由

`server/routes/qa.mjs` 负责：

- 读取并限制请求体大小。
- 鉴权。
- 规范化 question、scope、model、executionMode、answerLanguage。
- 创建 abort controller。
- 调用 retriever 或 agent runner。
- 调用统一 QA chat model stream。
- 写 SSE。
- 保存 messages、agent steps、tool calls、usage、citations。

### 9.2 Supabase service

新增 `server/supabase/qa.mjs`：

- `createQaThread`
- `insertQaMessage`
- `updateQaMessage`
- `insertQaCitations`
- `insertQaAgentStep`
- `insertQaToolCall`
- `listAccessibleDocuments`
- `listPaperChunksForRetrieval`
- `upsertPaperChunks`
- `upsertPaperReferences`
- `createOrUpdateIndexJob`

所有服务端写入必须带 `user_id`，并确认 `user_document_id` 属于当前用户。

### 9.3 Chat model client

当前 `server/deepseek/client.mjs` 只提供 DeepSeek stream chat。QA 需要新增 provider-neutral adapter：

- `createChatStream`
- `createChatCompletion`
- `normalizeQaChatModel`
- `serializeProviderError`

QA 回答模型只允许：

- `deepseek-v4-pro`
- `glm-5.2`

Rerank、query planning、gap analyzer 如果使用非流式模型，需要 `createChatCompletion`。翻译功能可以继续使用原有 DeepSeek flash/pro 选择，不与 QA 模型枚举合并。

### 9.4 Agent runner and tools

新增 `server/qa/agentRunner.mjs` 和 `server/qa/tools/*`：

```text
server/qa/tools/
  searchCurrentPaper.mjs
  searchReferencePapers.mjs
  searchLibrary.mjs
  openChunk.mjs
  compareEvidence.mjs
  verifyCitation.mjs
```

职责：

- 控制 agent 最大步数、检索次数和 token 预算。
- 把每一步转成结构化 `agent_step` SSE。
- 把每次工具调用写入 `user_qa_tool_calls`。
- 对工具入参做权限和 scope 校验。
- 禁止工具读取用户未授权文档。
- 将最终 evidence set 交给 answer composer 和 citation verifier。

### 9.5 后台任务

当前项目是单 Node API。可先使用进程内 job runner：

- 每个文档索引 job 单独执行。
- 同一用户同一文档只允许一个 active job。
- job 状态落库。
- 进程重启后，`pending` 和长时间 `extracting/embedding` 的任务可重新排队。

如果后续部署到多实例，需要迁移到 Supabase queue、Redis queue 或专门 worker。

## 10. 分步实施计划

### Step 1: 领域设计和配置

改动：

- 新增 QA domain types。
- 新增 `PROJECT_CONFIG.qa`。
- 新增环境变量文档。
- 新增 QA prompt version、chunker version、retriever version、agent runner version。
- 新增 QA 模型枚举：`deepseek-v4-pro`、`glm-5.2`。

验收：

- `npm run typecheck` 通过。
- 所有 version 常量集中可查。
- 翻译模型枚举和 QA 模型枚举相互独立。

### Step 2: Supabase schema

改动：

- 增加 `pgvector`、QA 表、索引、RLS policies。
- 增加 Storage 不需要新 bucket，QA 结构化数据进 Postgres。
- 给 `api_call_logs` payload 扩展 request kind，或新增 QA logs。

验收：

- 新用户不能读取其他用户 chunks/messages/citations。
- 删除文档后，QA 索引和会话按预期软删除或级联。

### Step 3: MathPix 手动触发和索引 job 基础设施

改动：

- 移除或关闭打开 PDF 后自动启动 MathPix 的默认行为。
- 新增“开始 MathPix 解析”按钮和状态处理。
- 用户点击后才调用现有 MathPix pipeline。
- MathPix 缓存命中时仍需要用户点击后才复用缓存并刷新状态。
- 新增 `server/qa/indexJobRunner.mjs`。
- 新增 `user_qa_index_jobs` 读写。
- MathPix 完成后只更新可索引状态，不自动触发 job。
- 新增手动创建索引 job 的 API 和 UI 入口。
- Ask 面板能读取索引状态。

验收：

- 上传或打开 PDF 不会自动触发 MathPix 或 QA 索引。
- 用户不点击“开始 MathPix 解析”时，不产生新的 MathPix submit/processing 记录。
- 用户点击“开始 MathPix 解析”后，可以复用已完成云端缓存或启动新解析。
- MathPix 完成后不会自动创建 QA index job。
- 只有用户点击“构建问答索引”才会出现新的 `user_qa_index_jobs` active job。
- 同一 PDF 重复触发不会产生并发重复 job。
- 失败 job 可重试。
- UI 可以看到 pending/running/ready/ready_degraded/error。

### Step 4: 文档结构化和 chunker

改动：

- 从 MathPix pages/fullMmd 生成结构化文档。
- 实现 chunk 切分。
- 写入 `user_paper_chunks`，无 embedding 时先保存文本和 fts。

验收：

- 每篇论文 chunk 覆盖主要正文页。
- chunk 保留正确页码。
- references 区域不污染正文问答 chunk，或单独标记。

### Step 5: Embedding provider

改动：

- 新增 `server/embedding/client.mjs`。
- 保留 embedding provider 抽象，但暂不锚定具体模型。
- 支持未配置 embedding 时进入 full-text + metadata boost 降级路径。
- 模型确定后再批量生成 embedding、写入 `user_paper_chunks.embedding` 并创建向量索引。
- 记录 embedding model 和维度。

验收：

- 支持批处理和失败重试。
- provider 配置缺失时，索引 job 不应直接失败；应进入 `ready_degraded` 或等价状态，并明确提示语义检索不可用。
- 不同 embedding model 不混用。

### Step 6: Reference extraction and matching

改动：

- 提取 bibliography。
- 写入 `user_paper_references`。
- 与用户文库中已导入论文匹配。

验收：

- DOI/arXiv 精确匹配成功。
- 标题 fuzzy match 有 confidence。
- 未导入参考文献不会进入 evidence pack。

### Step 7: Hybrid retrieval

改动：

- 实现 query planning。
- 实现 vector search。
- 实现 full-text search。
- 实现 metadata boost。
- 实现 top 50 -> top 15 rerank。

验收：

- 当前论文问题能优先召回当前论文证据。
- 跨论文比较能召回多篇论文证据。
- 专有名词、数据集名、公式名能通过 full-text 召回。

### Step 8: 受控多步检索 Agent Runner

改动：

- 新增 `server/qa/agentRunner.mjs`。
- 新增 `server/qa/gapAnalyzer.mjs`。
- 新增 `server/qa/tools/*`。
- 新增 `user_qa_agent_steps` 和 `user_qa_tool_calls` 写入逻辑。
- `/api/qa/stream` 支持 `executionMode: "rag" | "agentic"`。
- SSE 返回 `agent_step`、`tool_call`、`observation`、`gap_check`。

验收：

- comparison/citation_lookup/limitation 类问题可以触发 follow-up retrieval。
- agent steps 不超过配置上限。
- 连续两轮无新增 evidence 时自动停止。
- 所有工具调用都经过用户文档权限校验。
- 前端只展示结构化摘要，不展示原始 chain-of-thought。

### Step 9: QA stream API

改动：

- 新增 `/api/qa/stream`。
- SSE 返回 retrieval、agent_step、tool_call、observation、gap_check、delta、usage、verifier、done。
- 创建并保存 thread/messages。
- 错误和 abort 也写入 message 状态。
- 接入 `server/chatModels/client.mjs`，仅允许 `deepseek-v4-pro` 和 `glm-5.2`。

验收：

- 前端能看到流式回答。
- 断开连接后服务端停止 upstream 请求。
- API offline/unauthorized 有清晰错误。

### Step 10: Citation verifier

改动：

- 校验回答中的 evidence id。
- 生成结构化 citations。
- 写入 `user_qa_citations`。
- 向 UI 返回 verifier warning。

验收：

- 不存在的 citation id 不会保存为 verified。
- 引用必须属于当前用户可访问文档。
- citation chip 能定位到 chunk 文档和页码。

### Step 11: Ask 面板

改动：

- 新增 `PaperQaPanel` 和子组件。
- ReaderShell 加 Ask tab。
- 实现问答输入、流式消息、历史线程、证据抽屉。
- 实现多步检索过程面板。
- 实现引用跳转。

验收：

- 桌面和移动端可用。
- 不遮挡 PDF 选区和翻译卡片。
- 当前论文和其他论文引用都能打开定位。
- agentic 模式下能显示检索过程摘要和工具调用状态。

### Step 12: QA 同步和本地缓存

改动：

- IndexedDB 缓存最近线程和消息。
- IndexedDB 缓存最近 agent steps 和 citations。
- 云端 hydrate 当前文档 QA state。
- 文档删除时同步清理本地 QA 缓存。

验收：

- 换设备登录后能看到历史问答。
- 离线时可以查看已缓存历史，但不能新问答。
- 删除 PDF 后不残留孤立引用。

### Step 13: 设置、日志和成本统计

改动：

- Settings 增加 QA API logs。
- 记录 QA token usage、embedding usage、rerank usage、agent step/tool call count。
- 增加清理 QA 历史和重建索引按钮。
- 增加默认 QA 模型选择：`deepseek-v4-pro` 或 `glm-5.2`。

验收：

- 用户能看到 QA 调用成功/失败/耗时/token。
- 可以按当前 PDF 清理 QA 数据。
- 可以重建索引。

### Step 14: 评测集和回归测试

改动：

- 新增 `tests/qa/fixtures` 或脚本级评测数据。
- 覆盖 chunker、retriever、agent runner、citation verifier。
- 准备人工评测问题集。

指标：

- citation precision。
- evidence recall。
- unsupported claim rate。
- retrieval latency。
- answer latency。
- cost per question。
- average agent steps。
- follow-up retrieval usefulness。

验收：

- 核心 verifier 单元测试通过。
- 检索对固定样例有稳定 top-k 召回。
- 跨论文问题至少引用两篇相关论文。
- agentic 模式在复杂问题上的 evidence recall 高于单轮 RAG。

### Step 15: 发布和运维

改动：

- README 增加 QA 环境变量。
- 部署脚本检查 pgvector、chat model 和 embedding 配置。
- 健康检查返回 QA provider 配置状态。
- 增加后台 job 错误日志。
- 增加 VPS/worker 部署配置：私有 worker 地址、worker 鉴权、索引并发、embedding batch、单文档页数上限、单用户排队策略和 provider 降级状态。

验收：

- 生产环境能区分 DeepSeek、GLM、embedding provider、Supabase、MathPix、qa worker 状态。
- QA 失败不会影响 PDF 阅读和翻译。
- 可以安全回滚前端入口，同时保留索引数据。
- VPS 在 worker 离线、索引失败或模型不可用时保持可用，并能展示历史问答和明确错误状态。

## 11. 文件改动清单

前端：

- `src/types/domain.ts`
- `src/cache/indexedDb.ts`
- `src/app/ReaderShell.tsx`
- `src/qa/*`
- `src/i18n/messages.ts`
- `src/config/projectConfig.ts`
- `src/settings/SettingsPanel.tsx`

后端：

- `server/index.mjs`
- `server/routes/qa.mjs`
- `server/qa/*`
- `server/qa/tools/*`
- `server/chatModels/*`
- `server/embedding/client.mjs`
- `server/deepseek/client.mjs`
- `server/supabase/qa.mjs`
- `server/routes/health.mjs`

数据库：

- `supabase/schema.sql`

文档：

- `README.md`
- `docs/paper-qa-implementation-plan.md`

## 12. 风险和决策点

### 12.1 Embedding provider

Embedding 默认 provider 已确定为 Voyage API，模型为 `voyage-4-large`，向量维度为 1024。上线 full-text + metadata boost 和 agentic 检索流程时，仍要保留无 embedding 的降级路径；但正式 vector retrieval 的生产 schema 按 `vector(1024)` 设计。

建议决策：

- 默认易部署路线：`voyage-4-large` 托管 API。
- 如果后续优先隐私和低成本，可以在当前服务器的 `qa-worker` 中准备本地 embedding 服务；公网 VPS 不应承担这类重计算。
- Voyage provider 不可用或 API key 未配置时，索引 job 可以进入 `ready_degraded`，使用 full-text + metadata boost，并在 UI 中明确显示语义检索不可用。
- 如果将来从 `voyage-4-large` 切换到其他 embedding 模型，必须用新的 `embedding_model + embedding_dimensions` 创建新索引版本并重建 chunk embedding。

### 12.2 索引成本

大 PDF 和多论文文库会带来 embedding 成本。需要：

- 批处理。
- 去重 chunk hash。
- 只重建变化版本。
- 在 UI 展示索引状态。

### 12.3 引用可靠性

引用校验必须在服务端完成。前端只展示 verified/weak/rejected 状态，不自行相信模型输出。

### 12.4 多实例部署

进程内 job runner 适合当前单 Node 服务。多实例部署前必须迁移到真正队列，否则会有重复索引和 job 抢占问题。

### 12.5 Agentic QA 可控性

多步检索能提升复杂问题的证据召回，但必须有硬边界：

- 不展示或存储原始 chain-of-thought。
- 所有工具调用必须经过用户权限校验。
- 所有 follow-up retrieval 必须写入 `user_qa_agent_steps` 和 `user_qa_tool_calls`。
- 每次回答必须保存最终 evidence set，citation verifier 只接受 evidence set 内的引用。
- 达到步数、检索次数、token 或无新增证据上限后必须停止。

### 12.6 QA chat model provider

QA chat model 锚定为 `deepseek-v4-pro` 和 `glm-5.2`。风险点：

- 两个 provider 的流式协议、错误格式、usage 字段和上下文限制可能不同，必须通过 `server/chatModels/client.mjs` 归一。
- query planner、gap analyzer、answer composer 和 verifier 可能使用不同模型，默认应保持同一模型，减少风格和语义偏差。
- provider 不可用时需要明确错误：`qa_deepseek_unavailable`、`qa_glm_unavailable` 或通用 `qa_chat_provider_unavailable`。
- 不把翻译模型选择和 QA 模型选择混在同一个设置项里。

### 12.7 视觉检索

视觉检索不是当前阶段目标。不要在第一期引入页面截图上传、图表区域检测、多模态 embedding、视觉模型描述或图像证据引用。

后续如果要补视觉能力，应作为独立里程碑，而不是混入文本 RAG：

- 页面渲染和截图缓存。
- 图表、表格、公式、图片区域检测。
- caption 与正文邻近关系建模。
- 视觉摘要或多模态 embedding。
- `page + bbox` 级引用跳转和高亮。

### 12.8 VPS 与 worker 资源边界

公网 VPS 作为入口和控制面时，不能采用以下默认假设：

- 不在 VPS 上运行 LLM。
- 不在 VPS 上运行 embedding 模型。
- 不在 VPS 上运行 cross-encoder reranker。
- 不在 VPS 上自建 Milvus/Qdrant/Elasticsearch 等重型检索服务。
- 不在 VPS 上批量渲染和处理 PDF 页面图像。

当前服务器作为 `qa-worker` 可以承担重计算，但必须采用限流和降级：

- `QA_INDEX_CONCURRENCY=1`。
- `EMBEDDING_BATCH_SIZE` 从 8 或 16 起步，而不是 64。
- 每个用户同一时间只允许一个 active index job。
- 大 PDF 分页/分批索引，可以先让前 N 页或正文 chunk 可问，再后台补齐。
- worker 不可用时允许查看历史问答，但新 QA 必须返回明确的 `qa_worker_offline`。
- provider 不可用时允许 full-text-only 检索降级，但 UI 必须显示“语义检索不可用”。
- 健康检查中区分 `chat`、`embedding`、`vector_index`、`mathpix`、`qa_worker` 状态。

## 13. 部署方案

### 13.1 路线对比

当前有三种可选部署路线。

#### 路线 1：全部服务跑在当前服务器，VPS 只做公网转发

```text
Browser
  -> VPS Nginx / HTTPS
  -> reverse tunnel
  -> Current Server full app
     -> frontend static
     -> Node API
     -> QA indexing
     -> embedding/vector/rerank/chat
```

优点：

- 最快落地。
- 数据、本地模型、索引和 API 都在一台机器，调试简单。
- VPS 只承担 TLS 和反向代理，成本最低。

问题：

- 当前服务器、反向隧道或重计算任一环节异常，公网服务整体受影响。
- PDF 阅读、翻译、QA 索引、模型推理共享同一个应用运行环境，故障隔离差。
- 后续要拆 worker、限流、监控时，会从单体部署里再拆一次。

适合作为短期验证路线，不建议作为长期生产形态。

#### 路线 2：VPS 跑薄后端，当前服务器承担重计算

```text
Browser
  -> VPS Nginx / Node API
  -> private RPC / stream
  -> Current Server compute service
```

优点：

- 公网入口稳定在 VPS。
- 重计算不占用 VPS。
- 当前服务器不直接暴露公网。

问题：

- 如果 VPS 同步等待 compute service 返回，长索引任务和长回答流容易拖住 API 请求。
- 需要额外处理 worker offline、请求超时、任务取消、SSE 中断和重试。
- 如果没有持久 job 状态，进程重启后很难恢复任务。

路线 2 可以作为过渡，但必须尽快补 job store 和 worker 状态。

#### 路线 3：VPS 控制面 + 当前服务器私有 QA worker + 队列/状态层

这是推荐路线。

```text
Browser
  -> VPS Nginx / HTTPS
  -> VPS Node API
     -> auth
     -> rate limit
     -> QA job creation
     -> QA stream gateway
     -> health checks
  -> Supabase/Postgres job + state
  -> Current Server qa-worker
     -> document parsing
     -> chunking
     -> embedding
     -> vector search
     -> rerank
     -> optional local model inference
```

VPS 负责：

- 静态资源服务。
- API 鉴权和路由。
- 请求限流。
- 创建 QA index/chat job。
- 查询 QA job 状态。
- 作为浏览器 SSE 网关。
- 聚合 health check。

当前服务器负责：

- MathPix/PDF.js 结果结构化。
- chunk 切分。
- embedding。
- 向量检索和 full-text 检索执行。
- rerank。
- 可选本地 LLM/embedding 模型。
- 消费 job 并写回状态。

Supabase/Postgres 负责：

- 用户和权限。
- 文档元数据。
- QA job 状态。
- chunk、message、citation、usage。
- worker 重启后的任务恢复依据。

优点：

- 公网入口、状态存储和重计算解耦。
- 当前服务器可以承担重计算，但不需要直接暴露公网。
- worker 不在线时，阅读、历史问答、已有翻译仍可用。
- 后续可以增加第二个 worker，或把 worker 迁移到 GPU 机器。

代价：

- 初始工程量高于路线 1。
- 需要实现 job 状态机、worker 心跳、任务取消和超时恢复。

### 13.2 推荐落地架构

默认采用路线 3。

```text
Browser
  -> https://reader.example.com
  -> VPS Nginx
  -> VPS Node API
  -> Supabase Auth/Postgres/Storage
  -> private tunnel
  -> Current Server qa-worker
```

私有通道可选：

- SSH reverse tunnel：实现成本最低，适合当前阶段。
- WireGuard/Tailscale：适合长期稳定运行，网络拓扑更清晰。
- HTTPS worker endpoint + 防火墙白名单：可行，但安全配置要更谨慎。

推荐第一阶段使用 SSH reverse tunnel，并把 worker 端口只绑定在 loopback 或私有网络，不直接公网开放。

### 13.3 API 与 worker 边界

VPS Node API 对浏览器暴露：

- `POST /api/mathpix/documents` 或现有 MathPix 触发接口，仅由用户点击“开始 MathPix 解析”后调用。
- `POST /api/qa/index-jobs`
- `GET /api/qa/index-jobs/:id`
- `POST /api/qa/stream`
- `GET /api/qa/worker-health`

Current Server worker 对 VPS 暴露私有接口：

- `POST /worker/qa/index`
- `POST /worker/qa/retrieve`
- `POST /worker/qa/stream`
- `GET /worker/health`

索引任务不要用同步 HTTP 长请求完成。推荐流程：

```text
VPS API creates user_qa_index_jobs row
  -> worker polls/claims pending job
  -> worker updates status: extracting/chunking/embedding/ready/ready_degraded/error
  -> UI polls or subscribes to job status
```

问答流可以走同步 stream，但必须有降级：

```text
Browser opens /api/qa/stream on VPS
  -> VPS validates auth and scope
  -> VPS creates user/assistant message placeholder
  -> VPS opens private stream to worker
  -> worker streams retrieval/delta/usage/verifier
  -> VPS forwards SSE to browser and persists final status
```

如果 worker 不在线：

- 新 QA 返回明确错误：`qa_worker_offline`。
- 已有 QA 历史仍可查看。
- PDF 阅读和翻译不受影响。
- index job 保持 pending 或 stale，不丢失。

### 13.4 数据库选择

优先使用托管 Supabase Postgres + pgvector。如果当前服务器要承担全部重计算，也可以把向量库放在当前服务器，但不建议放在 VPS。

可选方案：

- 推荐：Supabase pgvector 保存 chunk embedding，worker 负责写入和查询。
- 可选：当前服务器自托管 Qdrant/pgvector，Supabase 只保存业务状态和 citations。
- 降级：只保存 `user_paper_chunks` 文本和 `fts`，先使用 full-text + metadata boost，不启用 embedding。

如果自托管向量库，必须额外规划：

- 定期备份。
- schema/version migration。
- 与 Supabase `chunk_id` 的一致性。
- worker 重建索引时的清理策略。

### 13.5 索引任务配置

VPS 环境变量建议：

```bash
QA_ENABLED=true
QA_MODE=control-plane
QA_WORKER_BASE_URL=http://127.0.0.1:19091
QA_WORKER_SHARED_SECRET=
QA_STREAM_TIMEOUT_MS=180000
QA_WORKER_HEALTH_TIMEOUT_MS=3000
QA_ALLOW_HISTORY_WHEN_WORKER_OFFLINE=true
QA_VISUAL_RETRIEVAL_ENABLED=false
QA_DEFAULT_CHAT_MODEL=deepseek-v4-pro
QA_AVAILABLE_CHAT_MODELS=deepseek-v4-pro,glm-5.2

DEEPSEEK_API_KEY=
DEEPSEEK_API_BASE_URL=
DEEPSEEK_QA_MODEL=deepseek-v4-pro

GLM_API_KEY=
GLM_API_BASE_URL=
GLM_QA_MODEL=glm-5.2
```

当前服务器 worker 环境变量建议：

```bash
QA_WORKER_ENABLED=true
QA_WORKER_HOST=127.0.0.1
QA_WORKER_PORT=9091
QA_INDEX_CONCURRENCY=1
QA_MAX_ACTIVE_JOBS_PER_USER=1
QA_CHUNK_TARGET_TOKENS=900
QA_CHUNK_OVERLAP_TOKENS=150
QA_MAX_DOCUMENT_PAGES_SYNC=120
QA_ALLOW_FULL_TEXT_FALLBACK=true
QA_AGENT_MAX_STEPS=8
QA_AGENT_MAX_RETRIEVAL_CALLS=4
QA_AGENT_MAX_OPEN_CHUNKS=20
QA_AGENT_STOP_ON_NO_NEW_EVIDENCE_ROUNDS=2

QA_DEFAULT_CHAT_MODEL=deepseek-v4-pro
QA_AVAILABLE_CHAT_MODELS=deepseek-v4-pro,glm-5.2

VOYAGE_API_KEY=
EMBEDDING_PROVIDER=voyage
EMBEDDING_MODEL=voyage-4-large
EMBEDDING_DIMENSIONS=1024
EMBEDDING_BATCH_SIZE=8
EMBEDDING_TIMEOUT_MS=60000

QA_RERANK_PROVIDER=voyage
QA_RERANK_MODEL=rerank-2.5
QA_RERANK_CANDIDATE_LIMIT=80
QA_RERANK_TOP_K=12
QA_VECTOR_PROVIDER=supabase-pgvector
```

### 13.6 分阶段部署路线

阶段 1：路线 1 快速验证。

- 当前服务器运行完整 app。
- VPS 通过 reverse tunnel 转发。
- 验证 Ask 面板、索引、QA stream、citation 跳转。
- 代码边界仍按 API/worker 拆分，不因为单机部署而写成不可拆的单体。

阶段 2：拆出 `qa-worker`。

- VPS 保留静态前端和 Node API。
- 当前服务器运行 worker。
- 索引任务改为 job 状态机。
- QA stream 经 VPS 转发 worker stream。

阶段 3：加强私有通道和监控。

- SSH tunnel 可继续使用，也可以迁移到 WireGuard/Tailscale。
- 增加 worker heartbeat。
- `/api/health` 返回 `qa_worker`、`vector_index`、`embedding`、`chat`、`mathpix` 状态。

阶段 4：扩展 worker。

- 文档量或用户数增加后，支持多个 worker claim job。
- 迁移到 Supabase queue、Redis queue 或专门任务队列。
- 重计算 worker 可以迁移到更强 CPU/GPU 机器。

阶段 5：视觉检索。

- 只有在文本 RAG 已稳定、并且有额外存储和视觉模型预算时再做。
- 不作为当前部署目标。

## 14. 推荐里程碑

Milestone A: 数据和索引闭环

- Schema。
- Index job。
- Chunker。
- Embedding。
- Index status UI。

Milestone B: 当前论文 QA 闭环

- Hybrid retrieval。
- QA stream。
- Citation verifier。
- Ask panel。
- 当前论文引用跳转。

Milestone C: 跨论文引用闭环

- Reference extraction。
- Reference matching。
- Reference scope picker。
- 其他论文引用打开定位。

Milestone D: 成熟化

- Thread cloud sync。
- QA logs。
- Cost view。
- Evaluation harness。
- Operations and health checks。

推荐上线策略：Milestone A 和 B 合并成第一个可用版本，但架构、schema、API 从一开始按成熟版实现，不走临时本地检索方案。
