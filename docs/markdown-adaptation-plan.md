# Markdown Reader Adaptation Plan

## 0. Scope

本文记录 Markdown 格式适配的产品约定、技术约束、pin 位置策略、缩放策略和分阶段实现方式。

目标是在当前 PDF Translate Reader 的基础上支持 `.md` / `.markdown` 文档导入、阅读、选句翻译、缓存、pin、导出阅读包，并尽量复用现有翻译、annotation、paper context 和云端同步能力。

非目标：

- 不支持在阅读器内编辑 Markdown。
- 不把 Markdown 转成 PDF 后再阅读。
- 不把 Markdown 的 pin 复制成一套独立业务系统。
- 不保证同一份 Markdown 被外部修改后还能把旧 pin 精确贴回修改后的正文。

## 1. Core Product Contracts

### 1.1 Immutable Uploaded Document

上传到阅读器的 Markdown 内容必须视为不可变。

- 同一个 `fingerprint` 对应的 Markdown 原文内容必须不可变。
- 修改后的 Markdown 应当被当作一个新文件重新导入，并生成新的 `fingerprint`。
- 旧文件的翻译缓存、pin、annotation 和 paper context 不自动迁移到新文件。
- 如果后续需要迁移能力，应设计为显式的 `import state from another document` 操作，而不是隐式复用旧 pin。

这个约束是 pin 强保底的基础。只要 `documentSha256` 一致，就可以用 canonical plain text 的全局文本 span 找回原文位置。

### 1.2 Shared Document Layer

Markdown 适配不应扩展出 `mdPin`、`mdTranslationCache`、`mdPaperContext` 等平行模型。建议把当前 PDF 专用命名逐步泛化为 document 命名。

```ts
type DocumentKind = "pdf" | "markdown";

type DocumentMetadata = {
  title?: string;
  author?: string;
};

type DocumentLibraryEntry = {
  cloudDocumentId?: string;
  contentSha256: string;
  fingerprint: string;
  fileName: string;
  fileSize: number;
  kind: DocumentKind;
  mimeType: "application/pdf" | "text/markdown";
  blob: Blob;
  importedAt: number;
  lastOpenedAt: number;
  openCount: number;
  lastPageIndex?: number;
  lastScrollLeft?: number;
  lastScrollTop?: number;
  lastZoom?: number;
  metadata?: DocumentMetadata;
  storagePath?: string;
  deletedAt?: number;
};
```

兼容期可以继续保留 `pdfFingerprint` 字段名，但内部新代码应尽量使用 `documentFingerprint` 语义。迁移完成后再统一重命名 IndexedDB 索引、云端字段和 archive manifest。

## 2. Markdown Rendering Strategy

### 2.1 Renderer

新增 `MarkdownViewer`，由 `ReaderShell` 根据文档类型分发：

```tsx
currentEntry.kind === "pdf"
  ? <PdfViewer ... />
  : <MarkdownViewer ... />
```

Markdown 渲染建议使用 `react-markdown + remark-gfm`，覆盖常见 GFM 表格、任务列表、删除线和链接。后续如需数学公式，可再增加 `remark-math + rehype-katex`。

### 2.2 Canonical Text

Markdown pin 和 selection 的稳定锚点应来自 canonical plain text，而不是 DOM 坐标。

建议在导入或渲染前生成：

```ts
type MarkdownCanonicalDocument = {
  contentSha256: string;
  fingerprint: string;
  sourceText: string;
  plainText: string;
  blocks: MarkdownTextBlock[];
};

type MarkdownTextBlock = {
  blockId: string;
  blockPath: string;
  kind: "heading" | "paragraph" | "listItem" | "code" | "tableCell" | "blockquote";
  sourceStart: number;
  sourceEnd: number;
  plainStart: number;
  plainEnd: number;
  text: string;
  textHash: string;
};
```

`blockId` 应由 `fingerprint + blockPath + plainStart + textHash` 生成，避免仅依赖 DOM 顺序。

### 2.3 Selection

Markdown selection 应生成与 PDF 兼容的 `SentenceSelection`，但语义上用 `documentFingerprint`。

```ts
type MarkdownSentenceSelection = {
  cloudDocumentId?: string;
  documentFingerprint: string;
  pageIndex: 0;
  blockId: string;
  blockPath: string;
  blockTextHash: string;
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
  blockTextSpan: {
    start: number;
    end: number;
  };
};
```

`rectsOnPage` 只作为当前渲染结果，不作为 Markdown pin 的永久位置。

## 3. Zoom Strategy

Markdown 需要同时支持两种缩放逻辑：

- `reflow`: 排版缩放，改变字号、行高和内容重排。
- `page`: 页面缩放，固定内容 surface 宽度并整体缩放，适合宽表格、代码、图片、公式和排版敏感内容。

```ts
type MarkdownZoomMode = "reflow" | "page";

type MarkdownViewState = {
  zoomMode: MarkdownZoomMode;
  textScale: number;
  pageScale: number;
  scrollTop: number;
  scrollLeft: number;
  anchorBlockId?: string;
  anchorBlockOffsetRatio?: number;
};
```

### 3.1 Reflow Zoom

排版缩放用于默认长文阅读。不要使用 `transform: scale()`，而是通过 CSS 变量控制字号。

```css
.markdown-body {
  --md-text-scale: 1;
  font-size: calc(16px * var(--md-text-scale));
  line-height: 1.72;
  max-width: 860px;
}

.markdown-body code,
.markdown-body pre {
  font-size: calc(0.92rem * var(--md-text-scale));
}
```

恢复阅读位置时优先使用 `anchorBlockId + anchorBlockOffsetRatio`，因为 reflow 后旧 `scrollTop` 会漂移。

### 3.2 Page Zoom

页面缩放用于排版敏感场景。内容 surface 使用固定未缩放宽度，外层提供滚动区域。

```css
.markdown-page-viewport {
  overflow: auto;
}

.markdown-page-spacer {
  width: calc(860px * var(--md-page-scale));
}

.markdown-page-surface {
  width: 860px;
  transform: scale(var(--md-page-scale));
  transform-origin: top left;
}
```

页面缩放下可以保存 `scrollTop / scrollLeft / pageScale`，行为更接近 PDF。

### 3.3 UI

阅读器复用 `- / + / reset` 控件，但 Markdown 增加缩放模式切换。

- `Aa`: 排版缩放。
- `Frame` 或页面图标: 页面缩放。

当前模式决定按钮修改 `textScale` 还是 `pageScale`。两个值各自记忆，不互相覆盖。

## 4. Pin Position Contract

### 4.1 Pin Content vs Card Placement

pin 必须分离两类信息：

- 文本锚点：pin 归属哪段原文。
- 卡片摆放：用户把翻译卡片放在哪里。

高亮、跳转和 annotation 面板定位永远基于文本锚点。用户手动拖动卡片只改变卡片摆放，不改变 pin 归属。

### 4.2 Stable Anchor

Markdown pin 应保存多层锚点：

```ts
type MarkdownPinAnchor = {
  documentSha256: string;
  documentFingerprint: string;
  canonicalVersion: number;
  globalTextSpan: {
    start: number;
    end: number;
  };
  blockId: string;
  blockPath: string;
  blockTextHash: string;
  blockTextSpan: {
    start: number;
    end: number;
  };
  exactText: string;
  normalizedSentence: string;
  prefixText: string;
  suffixText: string;
};
```

定位优先级：

1. `documentSha256 + globalTextSpan`
2. `blockId + blockTextSpan`
3. `exactText + prefixText + suffixText`
4. pin 原文快照

在 `documentSha256` 一致且 canonical plain text 算法版本一致时，第 1 层应当命中。第 2、3、4 层主要用于 parser 版本迁移或异常兜底。

### 4.3 Card Placement

卡片拖动位置使用原来的 `dx/dy`，单位为 CSS pixel。

浏览器 CSS pixel 与设备物理 DPI 解耦，因此低 DPI 和高 DPI 设备切换不会直接改变 `dx/dy` 的视觉语义。真正需要处理的是窗口尺寸、字体、缩放模式和排版变化。

```ts
type PinPlacement =
  | {
      mode: "anchor";
    }
  | {
      mode: "manual-offset";
      dx: number;
      dy: number;
      side: "right" | "left" | "top" | "bottom";
    }
  | {
      mode: "free";
      x: number;
      y: number;
      coordinateSpace: "markdown-surface";
    };
```

默认策略：

- 从未拖动过的卡片使用 `mode: "anchor"`，每次加载后贴近匹配文本。
- 用户拖动过的卡片使用 `mode: "manual-offset"`。
- 下次加载时先重新定位文本 anchor rect，再应用 `dx/dy`。
- 应用后将卡片 clamp 到当前 surface 或 viewport 可见范围内。
- 不建议默认使用比例偏移。

恢复示例：

```ts
const anchorRect = resolveAnchorRect(pin.anchor);
const basePoint = chooseBasePoint(anchorRect, pin.placement.side);

const cardLeft = clamp(basePoint.x + pin.placement.dx, bounds.left, bounds.right - cardWidth);
const cardTop = clamp(basePoint.y + pin.placement.dy, bounds.top, bounds.bottom - cardHeight);
```

### 4.4 Layout Change Handling

触发以下事件时，应重新计算当前页面可见 pin 的 rect 和卡片位置：

- Markdown 初次渲染完成。
- resize。
- 字体加载完成。
- 图片、公式、表格等异步内容加载完成。
- `zoomMode` 切换。
- `textScale` 或 `pageScale` 变化。
- 用户切换侧栏导致阅读区域宽度变化。

处理流程：

1. 使用 `MarkdownPinAnchor` 找到当前文本 DOM range。
2. 用 `range.getClientRects()` 计算高亮 rect。
3. 根据 `PinPlacement` 计算卡片位置。
4. 更新内存态，不把新 rect 当成永久锚点写回。

## 5. Strong Fallback Contract

在不可变 Markdown 约束下，目标是避免出现正常场景下的文本匹配失败。

强保底依赖：

- `documentSha256` 必须一致。
- canonical plain text 生成算法必须有版本号。
- pin 保存 `globalTextSpan` 和 exact text 快照。
- Markdown 不在阅读器内被编辑。
- 修改后的 Markdown 必须作为新文档导入。

如果 `documentSha256` 一致但第 1 层定位失败，应视为实现 bug 或 canonical 算法迁移问题，不能默默降级为位置消失。需要：

- 在开发环境输出诊断信息。
- 在 UI 中保留 pin 内容。
- 尝试第 2、3 层 fallback。
- fallback 成功后可以在内存中恢复显示，但不要无提示改写原 pin anchor。

如果 `documentSha256` 不一致，则说明当前文档已不是同一份不可变内容。此时不能承诺原位置精确恢复，只能保留 pin 内容和原文快照。

## 6. Implementation Steps

### Step 1. Add Document Type Compatibility Layer

目标：让现有 PDF 流程可以兼容通用 document 语义，但不大规模重命名。

实现：

- 在 `src/types/domain.ts` 增加 `DocumentKind`、`DocumentMetadata`、`DocumentLibraryEntry` 草案类型。
- 给现有 `PdfLibraryEntry` 增加可选 `kind?: "pdf"`，保持旧数据可读。
- 增加 `src/document/documentFingerprint.ts`：
  - PDF 调用现有 `createPdfFingerprint`。
  - Markdown 使用 SHA-256 生成 `contentSha256` 和 `fingerprint`。
- 增加 `src/document/documentTypes.ts`，集中判断 `isPdfFile`、`isMarkdownFile`、`isDocumentArchiveFile`。

验证：

- `npm run typecheck`
- 导入 PDF 行为不变。

### Step 2. Add Markdown Import MVP

目标：本地可导入 `.md` / `.markdown`，进入 library 并打开。

实现：

- 扩展 dropzone accept：`.md,.markdown,text/markdown,text/plain`。
- 新增 `saveImportedDocument` 或让 `saveImportedPdf` 先兼容 Markdown。
- 初期可以继续写入 `pdfLibrary` store，但 entry 必须有 `kind: "markdown"`。
- 云端同步先保持 PDF-only，Markdown MVP 可以 local-only；若必须同步，则需要先做 Step 8。

验证：

- 导入 Markdown 后刷新页面仍能看到历史项。
- 删除 Markdown 时清理对应 pin、cache、paper context 和 API log。

### Step 3. Build Markdown Canonical Parser

目标：为 selection 和 pin 生成稳定文本锚点。

实现：

- 新增 `src/markdown/markdownCanonical.ts`。
- 从 Markdown source 生成 `plainText`、`blocks`、`blockPath`、`textHash`。
- `canonicalVersion` 从 `1` 开始，变更算法时必须显式升级。
- 标题推断优先取 frontmatter `title`，其次第一个 H1，最后文件名。

验证：

- 同一 Markdown 内容重复导入得到相同 `contentSha256` 和 canonical text。
- 修改任意正文内容后得到不同 `contentSha256`，被当作新文档。

### Step 4. Build MarkdownViewer

目标：渲染 Markdown，并支持阅读位置和缩放。

实现：

- 新增 `src/markdown/MarkdownViewer.tsx`。
- 使用 `react-markdown + remark-gfm` 渲染。
- 为每个可选文本 block 写入 `data-block-id`、`data-plain-start`、`data-plain-end`。
- 支持 `zoomMode`、`textScale`、`pageScale`。
- `reflow` 模式恢复 `anchorBlockId + anchorBlockOffsetRatio`。
- `page` 模式恢复 `scrollTop / scrollLeft / pageScale`。

验证：

- 长文阅读字号缩放不破坏内容流。
- 宽表格或代码在 page zoom 下可横向滚动。
- 切换模式后当前阅读位置尽量稳定。

### Step 5. Adapt Selection

目标：Markdown 选区生成统一 `SentenceSelection`。

实现：

- 复用 `src/selection/sentenceBoundary.ts` 的句子切分。
- 抽出可复用的 plain text selection helper。
- 从 DOM selection 找到所属 block，映射到 canonical global span。
- 生成 `localContextBefore` 和 `localContextAfter`。

验证：

- 鼠标选中一句 Markdown 后能打开翻译卡片。
- 重复选中同一句命中翻译缓存。
- 跨 block 选区先做保守策略：不支持或拆成多 region。

### Step 6. Adapt Pin Anchor and Card Placement

目标：Markdown pin 在页面重排、缩放、resize 后能稳定回到文本位置，并尊重用户手动拖动卡片。

实现：

- 扩展 `TranslationPin` 或增加 `anchor` 字段保存 `MarkdownPinAnchor`。
- 扩展 pinned translation card 保存 `PinPlacement`。
- `mode: "anchor"` 时贴近文本。
- `mode: "manual-offset"` 时先定位文本，再应用 `dx/dy`。
- 页面变化后重新 resolve 当前可见 pin 的 DOM range 和 rect。

验证：

- pin 后刷新页面，高亮回到同一段文本。
- 拖动卡片到文本外，刷新后卡片按 anchor + `dx/dy` 恢复。
- 改变窗口宽度、切换 reflow/page zoom 后，pin 高亮仍贴住文本。

### Step 7. Archive Format v2

目标：阅读包支持 PDF 和 Markdown。

实现：

- 将 archive manifest 从 PDF-only 升级到 document manifest。
- v1 继续兼容 PDF 包。
- v2 使用：

```ts
type DocumentArchiveManifestV2 = {
  format: "pdf-translate-reader.archive";
  formatVersion: 2;
  document: {
    kind: "pdf" | "markdown";
    contentSha256: string;
    fingerprint: string;
    fileName: string;
    fileSize: number;
    mimeType: "application/pdf" | "text/markdown";
    metadata?: DocumentMetadata;
  };
  state: DocumentArchiveState;
};
```

验证：

- PDF v1 包仍可导入。
- Markdown v2 包导出后可重新导入并恢复 pin。

### Step 8. Cloud Schema Migration

目标：云端支持 Markdown，多设备同步。

实现：

- 新增或迁移 storage bucket：`user-documents`，允许 `application/pdf`、`text/markdown`、`text/plain`。
- `user_documents` 增加：
  - `document_kind`
  - `document_fingerprint`
  - `document_metadata`
- 保留旧 `pdf_fingerprint` 和 `pdf_metadata` 兼容历史数据。
- 子表逐步增加 `document_fingerprint`，旧 `pdf_fingerprint` 保留兼容。
- 前端云 repository 从 `pdfCloudRepository` 迁移为 `documentCloudRepository`。

验证：

- 旧 PDF 云端文档仍可打开。
- 新 Markdown 文档可多设备打开。
- pin、cache、paper context、card placement 可同步。

## 7. Experiment Plan

### Experiment 1. Local Markdown MVP

输入：

- 一篇普通英文 Markdown 长文。
- 一篇中文 Markdown 长文。
- 一篇包含宽表格、长代码块、图片链接的 Markdown。

验收：

- 可导入、打开、刷新恢复。
- 可选句翻译。
- 可 pin、取消 pin、重新翻译。
- `reflow` 和 `page` 两种 zoom 都可用。

### Experiment 2. Pin Stability

操作：

1. 在 Markdown 中 pin 5 个位置：段落、标题附近、列表项、代码块、表格单元格。
2. 将 2 个卡片拖到文本外。
3. 刷新页面。
4. 调整窗口宽度。
5. 切换 `reflow` 和 `page`。
6. 调整 `textScale` 和 `pageScale`。

验收：

- 高亮始终回到匹配文本。
- 未拖动卡片贴近文本。
- 已拖动卡片按文本 anchor + `dx/dy` 恢复。
- 卡片不跑出可见 bounds。

### Experiment 3. Immutable Fingerprint Contract

操作：

1. 导入 Markdown A。
2. pin 若干句子。
3. 修改本地源文件得到 Markdown B。
4. 导入 Markdown B。

验收：

- A 和 B 是两个不同 library entry。
- B 不自动继承 A 的 pin。
- A 的 pin 仍可恢复。
- 如果用户需要迁移，必须通过显式导入旧 state 的功能完成。

### Experiment 4. Canonical Anchor Fallback

操作：

1. 在相同 `documentSha256` 下模拟 DOM 结构变化。
2. 保持 canonical plain text 不变。
3. 尝试恢复 pin。

验收：

- `globalTextSpan` 能恢复位置。
- 如果 blockPath 变化，第 1 层仍能命中。
- 若第 1 层失败，开发环境输出诊断并尝试 fallback，不静默丢失 pin。

## 8. Recommended First PR Scope

第一版 PR 建议只做本地 Markdown MVP：

- document type compatibility layer
- Markdown fingerprint
- Markdown import local-only
- MarkdownViewer
- reflow/page zoom
- Markdown selection
- local pin anchor + `dx/dy` placement

暂缓：

- 云端 schema 迁移
- archive v2
- 旧字段大规模重命名
- 跨 Markdown 版本 pin 迁移

这样可以先验证核心阅读和 pin 体验，同时降低对现有 PDF 功能的影响。
