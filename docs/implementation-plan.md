# PDF Translate Reader Implementation Plan

## 0. Product Scope

初版目标是实现一个纯本地 Web PDF 论文阅读器：

- 用户在网页端导入 PDF，系统把 PDF 文件缓存到本地浏览器存储。
- 下次打开应用时展示历史打开记录，用户可以直接从历史记录重新打开 PDF。
- 用户选中任意片段后，系统自动扩展到完整句子。
- 使用前后 `N` 句作为局部上下文，默认 `N=2`，可调。
- 默认启用长期上下文：标题、摘要、前文术语。
- 调用 DeepSeek API 做英文到中文直译，默认模型为 `deepseek-v4-flash`，可切换 `deepseek-v4-pro`。
- 支持流式翻译。
- 本地缓存已翻译句子，避免重复调用 API。
- 翻译结果可以 pin 到原文旁边，滚动时跟随 PDF，手动关闭前不消失。
- 重新翻译允许切换模型，并替换当前 pin 结果。
- 记录 API 调用详情、token 统计、缓存命中信息。
- 不做账号、多设备同步、OCR、全文预翻译和复杂笔记系统。

## 1. Recommended Stack

建议优先使用：

- App: `Vite + React + TypeScript`
- PDF rendering: `pdfjs-dist`
- Local storage: `IndexedDB`
- API proxy: 本地 Node 服务，或后续改为 Next.js API route
- UI state: React state + lightweight store
- Runtime config: `.env.local` 保存 `DEEPSEEK_API_KEY`
- PDF library: IndexedDB 保存 PDF blob、metadata、最近打开记录和删除状态

初版用前后端同仓库实现，保持部署简单：

```text
pdf_translate_reader/
  docs/
  src/
    app/
    pdf/
    selection/
    translation/
    cache/
    pins/
    settings/
  server/
    deepseek/
```

## 2. Domain Model

### 2.1 PDF Identity

每个 PDF 用 fingerprint 绑定缓存和 pin。

```ts
type PdfFingerprint = {
  fingerprint: string;
  fileName: string;
  fileSize: number;
  modifiedAt?: number;
  pdfMetadata?: {
    title?: string;
    author?: string;
  };
};
```

fingerprint 优先使用 PDF.js 提供的 document fingerprint；如果不可用，再使用文件内容 hash。

### 2.2 PDF Library Entry

PDF 通过网页端文件选择或拖拽导入，文件本体保存到浏览器本地 IndexedDB。历史记录只展示本地缓存中仍存在的 PDF。

```ts
type PdfLibraryEntry = {
  fingerprint: string;
  fileName: string;
  fileSize: number;
  mimeType: "application/pdf";
  blob: Blob;
  importedAt: number;
  lastOpenedAt: number;
  openCount: number;
  lastPageIndex?: number;
  lastScrollTop?: number;
  pdfMetadata?: {
    title?: string;
    author?: string;
  };
  deletedAt?: number;
};
```

注意：

- 相同 fingerprint 的 PDF 重复导入时，不重复保存文件，只更新 `lastOpenedAt` 和 `openCount`。
- 历史记录默认按 `lastOpenedAt` 倒序展示。
- 删除历史记录时同步删除 PDF blob、该 PDF 的 pins、翻译缓存、API 日志和 paper context。
- 浏览器存储空间不足时，提示用户清理历史 PDF，不做静默淘汰。

### 2.3 Sentence Selection

```ts
type SentenceSelection = {
  pdfFingerprint: string;
  pageIndex: number;
  selectedText: string;
  targetSentence: string;
  normalizedSentence: string;
  localContextBefore: string[];
  localContextAfter: string[];
  rectsOnPage: DOMRectLike[];
  textSpan: {
    startGlobalChar: number;
    endGlobalChar: number;
  };
};
```

### 2.4 Translation Request

```ts
type TranslationRequest = {
  pdfFingerprint: string;
  sourceLang: "en";
  targetLang: "zh";
  model: "deepseek-v4-flash" | "deepseek-v4-pro";
  targetSentence: string;
  localContextBefore: string[];
  localContextAfter: string[];
  contextWindowN: number;
  longContextEnabled: boolean;
  paperContext?: PaperContext;
  promptVersion: string;
  stream: boolean;
};
```

### 2.5 Paper Context

```ts
type PaperContext = {
  title?: string;
  abstract?: string;
  terminology: Array<{
    source: string;
    target: string;
    confidence: "auto" | "user";
    updatedAt: number;
  }>;
  contextHash: string;
};
```

### 2.6 Translation Cache

```ts
type TranslationCacheEntry = {
  cacheKey: string;
  pdfFingerprint: string;
  normalizedSentence: string;
  sourceLang: "en";
  targetLang: "zh";
  model: "deepseek-v4-flash" | "deepseek-v4-pro";
  contextWindowN: number;
  longContextEnabled: boolean;
  paperContextHash?: string;
  promptVersion: string;
  translation: string;
  usage?: TokenUsage;
  createdAt: number;
  updatedAt: number;
};
```

cache key:

```text
pdfFingerprint
normalizedSentence
sourceLang
targetLang
model
contextWindowN
longContextEnabled
paperContextHash
promptVersion
```

### 2.7 Pin

```ts
type TranslationPin = {
  id: string;
  pdfFingerprint: string;
  pageIndex: number;
  selectedText: string;
  targetSentence: string;
  normalizedSentence: string;
  rectsOnPage: DOMRectLike[];
  translation: string;
  model: "deepseek-v4-flash" | "deepseek-v4-pro";
  targetLang: "zh";
  contextWindowN: number;
  longContextEnabled: boolean;
  cacheKey?: string;
  createdAt: number;
  updatedAt: number;
};
```

### 2.8 API Log

```ts
type ApiCallLog = {
  id: string;
  pdfFingerprint: string;
  model: "deepseek-v4-flash" | "deepseek-v4-pro";
  sourceLang: "en";
  targetLang: "zh";
  requestStartedAt: number;
  requestFinishedAt?: number;
  status: "success" | "error" | "aborted";
  errorMessage?: string;
  promptVersion: string;
  contextWindowN: number;
  longContextEnabled: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
};
```

## 3. DeepSeek Prompt Shape

为了提高 DeepSeek 前缀缓存命中率，稳定内容必须尽量放在 prompt 前部，动态内容放在后部。

推荐 message 结构：

```text
system:
You are a professional academic translator...
Only translate the target sentence into Simplified Chinese.
Preserve formulas, citations, variables, method names, dataset names...

user:
[Stable paper context]
Title: ...
Abstract: ...
Terminology:
- source => target

[Translation policy]
Source language: English
Target language: Simplified Chinese
Output only the translation.

[Dynamic local context]
Previous sentences:
...
Target sentence:
...
Following sentences:
...
```

注意：

- 不在稳定前缀前放时间戳、页码、随机 ID。
- 长期上下文开启时，标题、摘要、术语顺序保持稳定。
- 术语表自动更新时要生成新的 `paperContextHash`，避免本地缓存误命中。
- API 失败只展示错误，不自动降级模型。
- 流式请求使用 `stream: true`，并要求服务端把 token delta 透传给前端。
- 需要记录 DeepSeek 返回的 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`。

## 4. Implementation Milestones

### Step 1. Project Scaffold

目标：搭出可运行的本地 Web app。

任务：

- 初始化 `Vite + React + TypeScript`。
- 加入 PDF.js、IndexedDB 封装、基础样式系统。
- 新增本地 API proxy 服务骨架。
- 配置 `.env.local` 示例，不提交真实 API key。

产物：

- 可启动的 Web app。
- 空阅读器主界面。
- 本地服务健康检查接口。

验收：

- `npm run dev` 能打开页面。
- 设置 icon 存在，但内容可以先为空。
- 本地服务能返回 health check。

### Step 2. PDF Reader MVP

目标：在网页端导入 PDF、缓存 PDF，并从历史记录重新打开后稳定渲染阅读。

任务：

- 实现 PDF 文件选择和拖拽导入。
- 将导入的 PDF blob 保存到 IndexedDB。
- 启动应用时读取 PDF 历史记录。
- 空状态展示历史打开记录和导入入口。
- 从历史记录打开 PDF 时直接读取本地缓存，不要求用户再次选择文件。
- 重复导入同一 PDF 时复用已有缓存记录。
- 使用 PDF.js 渲染页面和 text layer。
- 支持滚动阅读。
- 保存当前打开 PDF 的 fingerprint、文件名、基础 metadata、最近打开时间和阅读位置。
- 页面主体大部分面积留给 PDF。

产物：

- `PdfViewer`
- `PdfImportDropzone`
- `PdfLibrary`
- `PdfLibraryRepository`
- `PdfFingerprint` 生成逻辑

验收：

- 能通过网页端导入一篇常规论文 PDF。
- 刷新页面后历史记录中能看到该 PDF。
- 从历史记录打开 PDF 时无需重新选择本地文件。
- 重复导入同一 PDF 不产生重复历史项。
- 文本层可选择。
- 滚动时页面布局稳定。

### Step 3. Text Extraction And Sentence Alignment

目标：把用户划中的任意片段扩展为完整句子。

任务：

- 从 PDF.js text layer 建立页面文本索引。
- 清洗文本：合并换行、修复 `trans-\nformer` 类断词、去掉明显多余空白。
- 根据选区找到原始 text span。
- 扩展到完整句子。
- 取前后 `N` 句作为局部上下文。
- 默认不处理纯图片 PDF 和内嵌图片文本。

产物：

- `selection/selectionToSpan.ts`
- `selection/sentenceBoundary.ts`
- `selection/contextWindow.ts`

验收：

- 用户选中半句话时，目标句能扩展为完整句。
- 前后上下文句数默认是 2。
- 多次选择同一句得到相同 `normalizedSentence`。

### Step 4. Translation API Proxy

目标：接入 DeepSeek，并支持流式翻译。

任务：

- 在本地服务实现 `POST /api/translate/stream`。
- 服务端读取 `DEEPSEEK_API_KEY`。
- 构造稳定 prompt。
- 默认模型使用 `deepseek-v4-flash`。
- 允许请求传入 `deepseek-v4-pro`。
- 实现 SSE 流式转发。
- 出错时返回结构化错误，不自动降级。

产物：

- `server/deepseek/client.ts`
- `server/deepseek/prompt.ts`
- `server/routes/translate.ts`

验收：

- 前端可以看到逐步出现的翻译文本。
- API 失败时翻译框显示错误。
- 重新翻译能切换模型。

### Step 5. Local Translation Cache

目标：同一句翻译过后再次划线不调 API。

任务：

- 建立 IndexedDB schema。
- 实现 translation cache 读写。
- 请求前先查 cache key。
- cache 命中时直接展示结果，并标记来源为 cache。
- 重新翻译强制绕过本地缓存，并覆盖该 cache entry。

产物：

- `cache/indexedDb.ts`
- `translation/cacheKey.ts`
- `translation/translationRepository.ts`

验收：

- 同一 PDF、同一句、同配置第二次划线直接展示缓存。
- 切换模型或上下文窗口后 cache key 改变。
- 重新翻译会更新缓存。

### Step 6. Floating Translation Box

目标：翻译结果显示在原文旁，而不是独立侧栏。

任务：

- 根据选区 rects 计算翻译框位置。
- 翻译框支持 loading、streaming、success、error 状态。
- 翻译框包含：模型标记、缓存命中标记、重新翻译、pin、关闭。
- 翻译框随 PDF 滚动移动。
- 翻译框不遮挡当前选中文本，必要时自动换侧。

产物：

- `translation/TranslationPopover`
- `pdf/pageOverlayLayer`

验收：

- 划线后翻译框出现在原文旁。
- 滚动时位置跟随 PDF 页面。
- 流式内容更新不会撑坏布局。

### Step 7. Pin Persistence

目标：pin 的翻译框绑定论文并可重加载。

任务：

- 实现 pin/unpin。
- pin 记录保存到 IndexedDB。
- 重新打开同一 PDF 时恢复 pin。
- 重新翻译 pinned 内容时替换 pin translation。
- 关闭 pin 只移除 pin，不删除普通翻译缓存。

产物：

- `pins/pinRepository.ts`
- `pins/PinnedTranslationLayer`

验收：

- pin 后滚动仍跟随原文。
- 手动关闭前不消失。
- 重载页面并重新打开同一 PDF，pin 能恢复。
- 重新翻译后 pin 显示新结果。

### Step 8. Settings Panel

目标：把所有调整入口收敛到单个 icon。

任务：

- 顶部或侧边只保留设置 icon。
- 设置面板支持：
  - 源语言和目标语言，默认英文到中文。
  - 默认模型，默认 `deepseek-v4-flash`。
  - 上下文窗口 N：`0 / 1 / 2 / 3 / 5`。
  - 拖动选词最大词数：默认 `128` words，最大 `256` words；只限制词级拖选的 target text，不改变句子级上下文窗口。
  - 长期上下文开关，默认开启。
  - 标题、摘要、术语详情。
  - API key 状态。
  - API 调用日志。
  - token 统计。
  - PDF 历史记录管理。
  - 清理缓存。
  - 清理当前 PDF 的本地文件和关联数据。
  - 清理当前 PDF 的 pins。

产物：

- `settings/SettingsButton`
- `settings/SettingsPanel`
- `settings/settingsRepository.ts`

验收：

- 设置变更后下一次翻译生效。
- 拖动选词超过最大词数时按配置裁剪，默认最多 `128` words，配置输入不可超过 `256` words。
- 主阅读界面不被设置项占据。
- 刷新页面后设置保留。

### Step 9. Paper Context And Terminology

目标：实现长期上下文默认开启，并为未来术语一致性打基础。

任务：

- 从 PDF metadata 和前几页文本中推断标题。
- 从摘要区域提取 abstract。
- 初版术语表允许手动维护，自动术语抽取可后置。
- 构造稳定 `PaperContext` 和 `contextHash`。
- 在 prompt 前部插入长期上下文。

产物：

- `translation/paperContext.ts`
- `settings/PaperContextEditor`

验收：

- 长期上下文开关默认开启。
- prompt 中稳定包含 title、abstract、terminology。
- 修改术语表后 cache key 随之变化。

### Step 10. API Logging And Usage Dashboard

目标：记录每次调用详情，便于后续成本分析和调试。

任务：

- 对每次 API 请求写入 `ApiCallLog`。
- 记录模型、状态、耗时、prompt 版本、上下文设置。
- 记录 token usage。
- 记录 DeepSeek cache hit/miss token。
- 设置面板中展示最近调用和累计统计。

产物：

- `translation/apiLogRepository.ts`
- `settings/UsageStatsPanel`

验收：

- 每次真实 API 调用都有日志。
- cache 命中不会生成真实 API 调用日志，可单独计为本地 cache hit。
- 能看到总 token、模型分布、错误次数、DeepSeek cache 命中情况。

### Step 11. Error Handling And Edge Cases

目标：让 MVP 在常见坏输入下可用。

任务：

- 处理无 text layer 的 PDF：提示暂不支持 OCR。
- 处理选区跨页。
- 处理多栏论文文本顺序异常。
- 处理浏览器本地 PDF 缓存空间不足。
- 处理历史记录指向的 PDF blob 读取失败。
- 处理 API 超时、限流、网络断开。
- 处理流式中途取消。
- 处理极长上下文，必要时裁剪到 token 预算内。

产物：

- `translation/errors.ts`
- `selection/edgeCases.ts`
- UI error states

验收：

- 图片型 PDF 给出明确提示。
- PDF 缓存失败时给出明确提示，不影响临时阅读当前文件。
- 历史记录损坏时允许移除该记录。
- API 失败不污染缓存。
- 用户关闭翻译框时能取消正在进行的流式请求。

### Step 12. Local Model Extension Point

目标：预留未来本地模型支持，不在初版实现模型推理。

任务：

- 抽象 `TranslationProvider` 接口。
- DeepSeek 实现为第一个 provider。
- 设置和日志中保存 provider id。
- prompt 构造与 provider 调用解耦。

产物：

- `translation/providers/types.ts`
- `translation/providers/deepseekProvider.ts`

验收：

- 替换 provider 不影响 PDF 选区、缓存、pin。
- cache key 中可加入 provider id。

## 5. Suggested Build Order

推荐按下面顺序推进：

1. `Step 1` 项目脚手架
2. `Step 2` PDF 阅读
3. `Step 3` 句子对齐
4. `Step 4` DeepSeek 流式翻译
5. `Step 5` 本地翻译缓存
6. `Step 6` 原文旁翻译框
7. `Step 7` pin 持久化
8. `Step 8` 设置面板
9. `Step 9` 长期上下文与术语
10. `Step 10` API 日志和 token 统计
11. `Step 11` 错误处理
12. `Step 12` 本地模型扩展点

前 7 步完成后，产品体验已经闭环：导入 PDF、历史记录重开、划线、翻译、缓存、pin、重加载恢复。

## 6. MVP Acceptance Checklist

- [ ] 可以在网页端导入 PDF。
- [ ] 导入的 PDF 会缓存到本地浏览器存储。
- [ ] 下次打开应用时可以从历史记录直接重新打开 PDF。
- [ ] PDF 文本可选择。
- [ ] 用户选中任意片段后能扩展到完整句子。
- [ ] 默认前后各 2 句上下文。
- [ ] 长期上下文默认开启。
- [ ] 默认模型为 `deepseek-v4-flash`。
- [ ] 支持 `deepseek-v4-pro` 重新翻译。
- [ ] DeepSeek 响应以流式方式展示。
- [ ] API 失败显示错误，不自动降级。
- [ ] 同一 PDF 同一句同配置重复选择命中本地缓存。
- [ ] 重新翻译会覆盖缓存和当前 pin。
- [ ] 翻译框出现在原文旁，并跟随 PDF 滚动。
- [ ] pin 后手动关闭前不消失。
- [ ] 重新加载同一 PDF 后 pin 可恢复。
- [ ] 设置入口只有一个 icon。
- [ ] API 调用日志记录模型、耗时、token、cache hit/miss。
- [ ] 图片型 PDF 显示暂不支持 OCR。
- [ ] 浏览器 PDF 缓存失败时显示明确提示。

## 7. Open Decisions Before Coding

这些细节不阻塞 MVP，但编码前最好确认：

- 本地服务采用 Node 还是 FastAPI。
- 是否要用 Next.js，把前端和 API route 合并。
- PDF 历史记录是否需要支持搜索、排序和重命名。
- 删除某个 PDF 历史项时，是否默认同步删除翻译缓存和 API 日志，还是提供二次选择。
- 浏览器存储空间不足时，是否只提示用户手动清理，还是提供最近最少打开 PDF 的清理建议。
- 术语表初版是否只手动维护。
- 跨页选区初版是支持、禁止，还是拆成多个句子处理。
- 多栏论文文本顺序异常时，是先提示用户，还是允许手动修正目标句。
